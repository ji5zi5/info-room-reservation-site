import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { requireAdmin, ForbiddenSessionError, UnauthorizedSessionError } from "@/lib/session";

export default async function AdminLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      redirect("/?admin=required");
    }
    if (error instanceof ForbiddenSessionError) {
      redirect("/?admin=forbidden");
    }
    throw error;
  }

  return children;
}
