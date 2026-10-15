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
