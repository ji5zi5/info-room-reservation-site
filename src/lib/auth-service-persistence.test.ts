import { beforeEach, describe, expect, it } from "vitest";

import {
  expectLoginSuccess,
  prismaPersistenceMocks,
  resetAuthPersistenceMocks,
  riroPersistenceMocks,
  riroSuccess,
  userRow
} from "./auth-service-persistence-test-support";
import { loginUserWithRiro } from "./auth-service";

beforeEach(() => {
  resetAuthPersistenceMocks();
});

describe("loginUserWithRiro persistence", () => {
  it("reconnects an existing Riro user when the student number changes", async () => {
    // Given
    prismaPersistenceMocks.seedUsers([
      userRow({
        bookingStatus: "RESTRICTED",
        id: "user-existing",
        restrictionReason: "late",
        restrictedUntil: new Date("2026-06-20T00:00:00.000Z"),
        riroId: "riro-student",
        shadowBanProfile: "HIGH",
        studentNumber: "old-24101"
      })
    ]);
    riroPersistenceMocks.loginWithRiroSchool.mockResolvedValueOnce(riroSuccess({ studentNumber: "new-25101" }));

    // When
    const result = await loginUserWithRiro({ id: "riro-student", password: "valid-password" });

    // Then
    const success = expectLoginSuccess(result);
    expect(success.user).toMatchObject({
      bookingStatus: "RESTRICTED",
      id: "user-existing",
      restrictionReason: "late",
      role: "STUDENT",
      shadowBanProfile: "HIGH",
      studentNumber: "new-25101"
    });
    expect(prismaPersistenceMocks.getUsers()).toHaveLength(1);
    expect(prismaPersistenceMocks.getUsers()[0]).toMatchObject({
      generation: 32,
      id: "user-existing",
      name: "재인증학생",
      riroId: "riro-student",
      studentNumber: "new-25101"
    });
    expect(prismaPersistenceMocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-existing" })
    });
  });

  it("moves a stale unlinked student-number row aside before reconnecting the Riro user", async () => {
    // Given
    prismaPersistenceMocks.seedUsers([
      userRow({ id: "user-existing", riroId: "riro-student", studentNumber: "old-24101" }),
      userRow({ id: "user-stale", riroId: null, studentNumber: "new-25101" })
    ]);
    riroPersistenceMocks.loginWithRiroSchool.mockResolvedValueOnce(riroSuccess({ studentNumber: "new-25101" }));

    // When
    const result = await loginUserWithRiro({ id: "riro-student", password: "valid-password" });

    // Then
    const success = expectLoginSuccess(result);
    const users = prismaPersistenceMocks.getUsers();
    expect(success.user.id).toBe("user-existing");
    expect(users.find((user) => user.id === "user-existing")).toMatchObject({
      riroId: "riro-student",
      studentNumber: "new-25101"
    });
    expect(users.find((user) => user.id === "user-stale")).toMatchObject({
      riroId: null,
      studentNumber: "relinked:new-25101:user-stale"
    });
  });

  it("returns an auth error when the new student number belongs to another linked Riro user", async () => {
    // Given
    prismaPersistenceMocks.seedUsers([
      userRow({ id: "user-existing", riroId: "riro-student", studentNumber: "old-24101" }),
      userRow({ id: "user-other", riroId: "other-riro", studentNumber: "new-25101" })
    ]);
    riroPersistenceMocks.loginWithRiroSchool.mockResolvedValueOnce(riroSuccess({ studentNumber: "new-25101" }));

    // When
    const result = await loginUserWithRiro({ id: "riro-student", password: "valid-password" });

    // Then
    expect(result).toEqual({
      kind: "error",
      message: "계정 정보가 충돌했습니다. 관리자에게 문의해주세요.",
      reason: "bad_response"
    });
    expect(prismaPersistenceMocks.sessionCreate).not.toHaveBeenCalled();
  });

  it("does not reactivate an account marked as departed", async () => {
    prismaPersistenceMocks.seedUsers([
      userRow({
        departedAt: new Date("2026-07-20T00:00:00.000Z"),
        id: "user-departed",
        riroId: "riro-student",
        studentNumber: "new-25101"
      })
    ]);
    riroPersistenceMocks.loginWithRiroSchool.mockResolvedValueOnce(
      riroSuccess({ studentNumber: "new-25101" })
    );

    const result = await loginUserWithRiro({
      id: "riro-student",
      password: "valid-password"
    });

    expect(result).toEqual({
      kind: "error",
      message: "사용할 수 없는 계정입니다. 관리자에게 문의해주세요.",
      reason: "bad_response"
    });
    expect(prismaPersistenceMocks.sessionCreate).not.toHaveBeenCalled();
    expect(prismaPersistenceMocks.transactionClient.user.update).not.toHaveBeenCalled();
  });
});
