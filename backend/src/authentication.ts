import type { AuthenticatedPrincipal } from "./authorization.js";

export interface AuthenticationProvider {
  authenticate(
    authorizationHeader: string | undefined,
    cookieHeader?: string,
  ): Promise<AuthenticatedPrincipal | null>;
}

export class RejectAllAuthenticationProvider
  implements AuthenticationProvider
{
  async authenticate(): Promise<null> {
    return null;
  }
}
