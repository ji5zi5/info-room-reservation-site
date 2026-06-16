type AdminAccountIdentity = {
  readonly generation: number;
  readonly name: string;
  readonly role: string;
  readonly studentNumber: string;
};

export function adminAccountName(user: AdminAccountIdentity): string {
  return user.role === "ADMIN" ? "관리자 계정" : user.name;
}

export function adminAccountDescription(user: AdminAccountIdentity): string {
  return user.generation === 0 ? user.studentNumber : `${user.studentNumber} · ${user.generation}기`;
}
