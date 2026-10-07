/**
 * RFC 9728 path-insertion probe location for the bare MCP URL.
 *
 * The canonical well-known path for resource https://fgac.ai/api/mcp is
 * /.well-known/oauth-protected-resource/api/mcp. Our 401s point at
 * /.well-known/oauth-protected-resource/mcp (the historical convention), but
 * clients that probe the spec location first — OpenAI's plugin scanner reads
 * either — used to get the site's 404 page here.
 */
export { GET, OPTIONS } from '../../mcp/route';
