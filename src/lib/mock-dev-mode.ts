import { isMockLoginEnabled } from "./env";

export function isNoDatabaseMockMode(): boolean {
  return isMockLoginEnabled();
}
