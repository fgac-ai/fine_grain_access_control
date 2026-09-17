import { FileGrantRecovery } from "../FileGrantRecovery";

/* ─── Slides setup / grant recovery ──────────────────────────────────────
   Slides twin of /dashboard/sheets-setup and /dashboard/docs-setup: the
   landing spot whenever a slides FGAC rule exists (or was just approved via
   magic link) but Google has no drive.file grant for the presentation. Walks
   the user through the ONE action that registers the grant (picking the
   presentation in the Google Picker).

   Reached from: the magic-link approve flow (`from=approval`), the
   dashboard's "needs Google access" chip, and the MCP stranded-presentation
   error.

   The first-time drive.file consent redirect returns to this pathname with
   `autoOpenPicker=true&pickerKind=slide&pickerContext=<pid>` (and nothing
   else), so the pid is restored from pickerContext on that leg. */

export default async function SlidesSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ pid?: string; name?: string; from?: string; pickerContext?: string }>;
}) {
  const params = await searchParams;
  const pid = params.pid || params.pickerContext || null;
  return (
    <FileGrantRecovery
      kind="slide"
      fileId={pid}
      resourceName={params.name || null}
      fromApproval={params.from === "approval"}
    />
  );
}
