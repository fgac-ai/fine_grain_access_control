"use client";

import { useState, useEffect, useTransition } from "react";
import { updateRule } from "./actions";
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS, kindForService } from "@/lib/driveFileKinds";

interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

interface EditableRule {
  id: string;
  ruleName: string;
  service: string;
  actionType: string;
  regexPattern: string | null;
  targetResourceId?: string | null;
  resourceName?: string | null;
  targetEmail: string | null;
  assignedKeyIds: string[];
}

interface ProxyKeyInfo {
  id: string;
  label: string;
}

export function EditRuleButton({
  rule,
  accessibleEmails = [],
  activeKeys = [],
}: {
  rule: EditableRule;
  accessibleEmails?: string[];
  activeKeys?: ProxyKeyInfo[];
}) {
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedService, setSelectedService] = useState(rule.service);
  const [selectedActionType, setSelectedActionType] = useState(rule.actionType);
  const selectedFileKind = kindForService(selectedService);
  const [gmailLabels, setGmailLabels] = useState<GmailLabel[]>([]);
  const [isLoadingLabels, setIsLoadingLabels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * See RuleControls: React 19 resets an uncontrolled form after its action
   * resolves. Here that would silently revert the user's edits to the rule's
   * stored values, which reads as "my change was saved" when it was rejected.
   */
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [draftKeyIds, setDraftKeyIds] = useState<string[] | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    if (isOpen && selectedService === 'gmail' && gmailLabels.length === 0) {
      const fetchLabels = async () => {
        setIsLoadingLabels(true);
        try {
          const res = await fetch('/api/gmail/labels');
          const data = await res.json();
          if (!ignore && data && data.labels) {
            setGmailLabels(data.labels.filter((l: GmailLabel) => l.type === 'user' || l.type === 'system'));
          }
        } catch (err) {
          if (!ignore) console.error("Failed to load labels:", err);
        } finally {
          if (!ignore) setIsLoadingLabels(false);
        }
      };
      
      fetchLabels();
    }
    return () => { ignore = true; };
  }, [isOpen, selectedService, gmailLabels.length]);

  function closeModal() {
    setIsOpen(false);
    setError(null);
    setDraft(null);
    setDraftKeyIds(null);
  }

  async function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      // Returned failure, not a thrown one — see RuleControls for why.
      const result = await updateRule(formData);
      if (!result.ok) {
        setDraft({
          ruleName: String(formData.get("ruleName") ?? ""),
          regexPattern: String(formData.get("regexPattern") ?? ""),
          targetEmail: String(formData.get("targetEmail") ?? ""),
        });
        setDraftKeyIds(formData.getAll("keyIds").map(String));
        setFormKey(k => k + 1);
        setError(result.error);
        return;
      }
      setDraft(null);
      setDraftKeyIds(null);
      setIsOpen(false);
    });
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-opacity"
      >
        Edit
      </button>

      {isOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 transition-all">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 border border-slate-200 max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold text-slate-900 mb-1">
              Edit Rule
            </h3>
            <p className="text-sm text-slate-800 mb-5">
              Update the rule&apos;s settings and key assignments.
            </p>

            <form key={formKey} action={onSubmit} className="flex flex-col gap-5">
              <input type="hidden" name="ruleId" value={rule.id} />

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Rule Name
                </label>
                <input
                  type="text"
                  name="ruleName"
                  required
                  defaultValue={draft?.ruleName ?? rule.ruleName}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Service
                </label>
                <select
                  name="service"
                  value={selectedService}
                  onChange={(e) => {
                    setSelectedService(e.target.value);
                    const fileKind = kindForService(e.target.value);
                    setSelectedActionType(fileKind ? DRIVE_FILE_KINDS[fileKind].actionTypes.read : 'read_blacklist');
                  }}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                >
                  <option value="gmail">Gmail</option>
                  {ACTIVE_DRIVE_FILE_KINDS.map(k => (
                    <option key={k} value={DRIVE_FILE_KINDS[k].service}>{DRIVE_FILE_KINDS[k].productName}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Action Type
                </label>
                <select
                  name="actionType"
                  value={selectedActionType}
                  onChange={(e) => setSelectedActionType(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                >
                  {selectedFileKind ? (
                    <>
                      <option value={DRIVE_FILE_KINDS[selectedFileKind].actionTypes.read}>
                        Read Only (GET)
                      </option>
                      <option value={DRIVE_FILE_KINDS[selectedFileKind].actionTypes.readWrite}>
                        Read & Write (GET + POST/PUT)
                      </option>
                      <option value={DRIVE_FILE_KINDS[selectedFileKind].actionTypes.block}>
                        Blocked (Deny All)
                      </option>
                    </>
                  ) : (
                    <>
                      <option value="read_blacklist">
                        Read Blacklist (Inbound Regex)
                      </option>
                      <option value="send_whitelist">
                        Send Whitelist (Outbound To:)
                      </option>
                      <option value="delete_whitelist">
                        Delete Whitelist (From:)
                      </option>
                      <option value="label_blacklist">
                        Label Blacklist (Block Email via Label)
                      </option>
                      <option value="label_whitelist">
                        Label Whitelist (Allow Only via Required Label)
                      </option>
                    </>
                  )}
                </select>
              </div>

              {selectedFileKind ? (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                    {DRIVE_FILE_KINDS[selectedFileKind].noun.charAt(0).toUpperCase() + DRIVE_FILE_KINDS[selectedFileKind].noun.slice(1)} ID
                  </label>
                  <input
                    type="text"
                    name="regexPattern"
                    required
                    defaultValue={draft?.regexPattern ?? (rule.targetResourceId || rule.regexPattern || "")}
                    placeholder="e.g. 1cS2oyMtx-Wa..."
                    className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Document Title: {rule.resourceName || DRIVE_FILE_KINDS[selectedFileKind].productName}
                  </p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                    {selectedActionType.startsWith('label_') ? 'Select Label' : 'Match Pattern'}
                  </label>
                  {selectedActionType.startsWith('label_') ? (
                    <select
                      name="regexPattern"
                      required
                      defaultValue={draft?.regexPattern ?? (rule.regexPattern || "")}
                      className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                    >
                      <option value="">{isLoadingLabels ? "Loading labels..." : "Choose a Gmail Label..."}</option>
                      {gmailLabels.map(label => (
                         <option key={label.id} value={label.id}>{label.name} ({label.type})</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <input
                        type="text"
                        name="regexPattern"
                        required
                        defaultValue={draft?.regexPattern ?? (rule.regexPattern || "")}
                        className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        <code>*</code> matches anything.
                      </p>
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Apply to Email
                </label>
                <select
                  name="targetEmail"
                  defaultValue={draft?.targetEmail ?? (rule.targetEmail || "")}
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                >
                  <option value="">All accessible emails</option>
                  {accessibleEmails.map((email) => (
                    <option key={email} value={email}>
                      {email}
                    </option>
                  ))}
                </select>
              </div>

              {activeKeys.length > 0 && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                    Assign to Specific Keys
                  </label>
                  <div className="flex flex-col gap-2">
                    {activeKeys.map((k) => (
                      <label
                        key={k.id}
                        className="flex items-center gap-2 text-sm text-slate-800"
                      >
                        <input
                          type="checkbox"
                          name="keyIds"
                          value={k.id}
                          defaultChecked={(draftKeyIds ?? rule.assignedKeyIds).includes(k.id)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        {k.label}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Leave all unchecked for a global rule that applies to every
                    key.
                  </p>
                </div>
              )}

              {error && (
                <p role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-md disabled:opacity-50 shadow-sm transition-colors"
                >
                  {isPending ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
