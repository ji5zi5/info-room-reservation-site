export function isAuthorizedCronRequest(authorizationHeader: string | null, cronSecret: string | undefined): boolean {
  if (!cronSecret) {
    return false;
  }
  return authorizationHeader === `Bearer ${cronSecret}`;
}
