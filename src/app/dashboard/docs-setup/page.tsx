import { FileGrantRecovery } from "../FileGrantRecovery";

/* ─── Docs setup / grant recovery ────────────────────────────────────────
   Docs twin of /dashboard/sheets-setup: the landing spot whenever a docs
   FGAC rule exists (or was just approved via magic link) but Google has no
   drive.file grant for the document. Walks the user through the ONE action
   that registers the grant (picking the doc in the Google Picker).

   Reached from: the magic-link approve flow (`from=approval`), the
   dashboard's "needs Google access" chip, and the MCP stranded-doc error.

   The first-time drive.file consent redirect returns to this pathname with
   `autoOpenPicker=true&pickerKind=doc&pickerContext=<did>` (and nothing
   else), so the did is restored from pickerContext on that leg. */

export default async function DocsSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ did?: string; name?: string; from?: string; pickerContext?: string; profile?: string }>;
}) {
  const params = await searchParams;
  const did = params.did || params.pickerContext || null;
  return (
    <FileGrantRecovery
      kind="doc"
      fileId={did}
      resourceName={params.name || null}
      fromApproval={params.from === "approval"}
      profileSlug={params.profile ?? null}
    />
  );
}
