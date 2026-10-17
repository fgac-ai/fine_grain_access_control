import { FileGrantRecovery } from "../FileGrantRecovery";

/* ─── Sheets setup / grant recovery ──────────────────────────────────────
   The landing spot whenever a sheets FGAC rule exists (or was just approved
   via magic link) but Google has no drive.file grant for the spreadsheet —
   the state every connector-launch user stranded in. Walks the user through
   the ONE action that registers the grant (picking the sheet in the Google
   Picker) with the demo video alongside.

   Reached from: the magic-link approve flow (`from=approval`), the
   dashboard's "needs Google access" chip, and the MCP stranded-sheet error.

   The first-time drive.file consent redirect returns to this pathname with
   `autoOpenPicker=true&pickerKind=sheet&pickerContext=<sid>` (and nothing
   else), so the sid is restored from pickerContext on that leg. */

export default async function SheetsSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ sid?: string; name?: string; from?: string; pickerContext?: string; profile?: string }>;
}) {
  const params = await searchParams;
  const sid = params.sid || params.pickerContext || null;
  return (
    <FileGrantRecovery
      kind="sheet"
      fileId={sid}
      resourceName={params.name || null}
      fromApproval={params.from === "approval"}
      profileSlug={params.profile ?? null}
    />
  );
}
