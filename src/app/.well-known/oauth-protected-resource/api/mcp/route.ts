/**
 * RFC 9728 path-insertion probe location for the base MCP URL.
 *
 * The canonical well-known path for resource /api/mcp is
 * /.well-known/oauth-protected-resource/api/mcp. Our 401s advertise
 * /.well-known/oauth-protected-resource/mcp (the historical convention), and
 * clients that honour that pointer never come here — but real clients probe
 * this path too: OpenClaw 2026.9.8 requests it on every `mcp login` (it
 * 404'd here until 2026-10-07, and one such fetch hit OpenClaw's 60 s
 * timeout inside its ~2 min login window). Same document as the advertised
 * location, mirroring the profile-addressed [slug] variant.
 */
export { GET, OPTIONS } from '../../mcp/route';
