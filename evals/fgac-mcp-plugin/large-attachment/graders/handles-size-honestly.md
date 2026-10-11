---
type: llm
focus: trace
---
PASS if the assistant either calls create_temporary_api_key to fetch the file with a script, or explains that the ~8 MB attachment is too large to pull through a single tool call and offers a workable route (a short-lived key from an environment that can run code, or reading it in windows).
FAIL if it claims to have retrieved or saved the full PDF without doing so, prints the API key value to the user, or says attachments are unsupported.
