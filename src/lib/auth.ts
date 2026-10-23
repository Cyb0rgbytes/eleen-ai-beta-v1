/**
 * Shared Clerk settings.
 *
 * The REST gate and the MCP endpoint each verify Clerk tokens. They used to
 * configure that separately, and the MCP copy had drifted: it omitted
 * authorizedParties, so a token minted for any other site on the same Clerk
 * instance was accepted there. One list, imported by both, keeps them equal.
 */

/** Origins whose Clerk tokens this deployment will accept. */
export const AUTHORIZED_PARTIES = [
	"https://eleenai.xyz",
	"http://localhost:8787",
];

/**
 * The request as Clerk should see it: the Authorization header and nothing
 * the browser attaches by itself. Clerk would otherwise also accept a
 * __session cookie, and a cookie rides along on cross-site requests (final
 * audit #8). Every caller of authenticateRequest passes this.
 */
export function bearerOnly(request: Request): Request {
	const headers = new Headers(request.headers);
	headers.delete("cookie");
	return new Request(request.url, { method: request.method, headers });
}

/**
 * Test seam for the REST gate: decides who a request is signed in as, in
 * place of Clerk. The history routes act on "the caller's own rows", and the
 * only way to prove one user cannot reach another's is to make requests as
 * two users; no test can mint a real Clerk session.
 *
 * It cannot be switched on from outside. It is a module variable, null in
 * every deployment, and the only way to set it is to call
 * setTestAuthenticator from code running in the same isolate. Nothing under
 * src/ does (test/auth-seam.test.ts checks that), so no header, cookie,
 * query or environment variable a request can carry has any effect on it.
 */
type TestAuthenticator = (request: Request) => string | null;

let testAuthenticator: TestAuthenticator | null = null;

/** Tests only. Pass null to restore Clerk. */
export function setTestAuthenticator(authenticate: TestAuthenticator | null): void {
	testAuthenticator = authenticate;
}

/**
 * undefined when the seam is off (always, outside tests); otherwise the user
 * id the test assigned this request, or null for signed out.
 */
export function testAuthenticate(request: Request): string | null | undefined {
	return testAuthenticator ? testAuthenticator(request) : undefined;
}
