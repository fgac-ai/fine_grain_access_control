/**
 * Per-tool-call analytics context (delegation observability).
 *
 * The `mcp_tool_call` capture lives in a generic wrapper that has no view of
 * what the tool did internally — in particular which Google account a call
 * resolved to, which is the fact delegation analytics need. AsyncLocalStorage
 * carries extra properties from wherever they become known (account
 * resolution) back to the wrapper's single capture call, without threading a
 * context parameter through every tool signature.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type ToolCallProps = Record<string, unknown>;

const storage = new AsyncLocalStorage<ToolCallProps>();

/** Run `fn` with a fresh property bag; the wrapper reads it after `fn` settles. */
export function runWithToolCallProps<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Merge properties into the current call's bag. No-op outside a wrapped call. */
export function addToolCallProps(props: ToolCallProps): void {
  const bag = storage.getStore();
  if (bag) Object.assign(bag, props);
}

/** Properties accumulated during the current call ({} outside one). */
export function getToolCallProps(): ToolCallProps {
  return { ...(storage.getStore() ?? {}) };
}

/**
 * Request-scoped properties set by the transport wrapper BEFORE the SDK
 * dispatches the tool (argument aliases applied to the call — see
 * mcpArgumentGuidance.ts). A separate store from the per-call bag because
 * the bag is created inside withToolAnalytics, after the SDK has already
 * validated the rewritten arguments.
 */
const requestStorage = new AsyncLocalStorage<ToolCallProps>();

/** Run `fn` with request-level properties every wrapped tool call inherits. */
export function runWithRequestProps<T>(props: ToolCallProps, fn: () => T): T {
  return requestStorage.run(props, fn);
}

/** Properties set for the current request ({} outside one). */
export function getRequestProps(): ToolCallProps {
  return { ...(requestStorage.getStore() ?? {}) };
}
