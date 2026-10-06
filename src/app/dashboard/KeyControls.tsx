"use client";

import { useState, useTransition } from "react";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { createProxyKey, revokeProxyKey, rollProxyKey } from "./actions";

const PROXY_ENDPOINT = "https://gmail.fgac.ai";

interface AccessibleEmail {
  email: string;
  type: 'own' | 'delegated';
  delegationId?: string;
  hasCompleteGoogleAccess?: boolean;
}

interface ProxyKey {
  id: string;
  key: string;
  label: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  emailAccess: string[]; // email addresses this key can access
}

export function SecretKeyDisplay({
  apiKey,
  className = "text-sm text-slate-700",
  iconSize = 14,
}: {
  apiKey: string;
  className?: string;
  iconSize?: number;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const maskedKey = "sk_proxy_" + "•".repeat(24);

  return (
    <div className={`inline-flex items-center gap-2 font-mono bg-muted border border-border px-2 py-1 rounded-xs mt-1.5 ${className}`}>
      <span className="min-w-0 truncate">{isVisible ? apiKey : maskedKey}</span>
      <button
        onClick={() => setIsVisible(!isVisible)}
        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground focus:outline-none transition-colors"
        title={isVisible ? "Hide Key" : "Reveal Key"}
      >
        {isVisible ? <EyeOff size={iconSize} /> : <Eye size={iconSize} />}
      </button>
      <button
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground focus:outline-none transition-colors"
        title="Copy to clipboard"
      >
        {copied ? <Check size={iconSize} className="text-primary" /> : <Copy size={iconSize} />}
      </button>
    </div>
  );
}

export function KeyControls({
  accessibleEmails,
  existingKeys,
  variant = 'panel',
  triggerLabel = 'Create New Key',
  triggerClassName,
}: {
  accessibleEmails: AccessibleEmail[];
  existingKeys: ProxyKey[];
  /**
   * 'panel' renders the full API-keys list (legacy layout).
   * 'button' renders only the create trigger + modal, for hosts that already
   * present the keys themselves — e.g. the profile tab strip.
   */
  variant?: 'panel' | 'button';
  triggerLabel?: string;
  triggerClassName?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ proxyKey: string; privateKey: string } | null>(null);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);

  const isSelectable = (ae: AccessibleEmail) => !(ae.type === 'own' && ae.hasCompleteGoogleAccess === false);

  function openModal() {
    // A profile with no mailbox is a dead key (every proxy call 403s), so
    // start from the user's own linked mailbox — or, if it isn't linked, the
    // first delegated one — and never let the form submit with none.
    const selectable = accessibleEmails.filter(isSelectable);
    const initial = selectable.find(ae => ae.type === 'own') ?? selectable[0];
    setSelectedEmails(initial ? [initial.email] : []);
    setCreateError(null);
    setCreated(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
    setCreated(null);
  }

  function downloadSaJson(proxyKey: string, privateKey: string) {
    const jsonContent = JSON.stringify({
      type: "service_account",
      project_id: "fgac-proxy",
      private_key_id: proxyKey,
      private_key: privateKey,
      client_email: `${proxyKey}@fgac.ai`,
      client_id: proxyKey,
      auth_uri: "https://accounts.fgac.ai/o/oauth2/auth",
      token_uri: "https://oauth2.fgac.ai/token",
      auth_provider_x509_cert_url: "https://www.fgac.ai/oauth2/v1/certs",
      client_x509_cert_url: `https://www.fgac.ai/robot/v1/metadata/x509/${proxyKey}%40fgac.ai`,
    }, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `fgac-credentials-${proxyKey.substring(0, 16)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function onSubmit(formData: FormData) {
    startTransition(async () => {
      try {
        setCreateError(null);
        const result = await createProxyKey(formData);

        if ('error' in result) {
          // Validation refusals (e.g. a label whose URL slug collides with an
          // existing profile) come back as values — production masks thrown
          // server-action messages, and the user needs to see the reason.
          setCreateError(result.error ?? "Profile creation was refused.");
          return;
        }

        if (result?.privateKey && result?.proxyKey) {
          // Shown in the dialog, not window.alert/confirm: native dialogs are
          // inert in the Claude desktop pane, and a modal alert is a poor
          // place to hand over a secret.
          setCreated({ proxyKey: result.proxyKey, privateKey: result.privateKey });
          try {
            await navigator.clipboard.writeText(result.proxyKey);
          } catch { /* Clipboard may not be available */ }
          return;
        }

        setIsModalOpen(false);
      } catch (err) {
        console.error("Failed to create key", err);
        setCreateError("Something went wrong creating the profile. Please try again.");
      }
    });
  }

  const activeKeys = existingKeys.filter(k => !k.revokedAt);
  const revokedKeys = existingKeys.filter(k => k.revokedAt);

  return (
    <>
      {variant === 'button' ? (
        <button
          onClick={openModal}
          className={triggerClassName ?? 'inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground hover:bg-muted'}
        >
          {triggerLabel}
        </button>
      ) : (
      <>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-gray-900">API Keys</h2>
        <button
          onClick={openModal}
          className="bg-blue-600 text-white hover:bg-blue-500 px-4 py-2 text-sm font-medium rounded-md transition-all shadow-sm"
        >
          {triggerLabel}
        </button>
      </div>

      {activeKeys.length === 0 && (
        <p className="text-sm text-gray-800 bg-amber-50 border border-amber-200 rounded-md p-4">
          No active API keys. Create one to give your agents access.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {activeKeys.map((k) => (
          <div
            key={k.id}
            className="bg-white border border-gray-200 rounded-lg shadow-sm p-4"
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="font-semibold text-gray-900">{k.label}</p>
                <SecretKeyDisplay apiKey={k.key} />
                <div className="mt-2 flex flex-wrap gap-1">
                  {k.emailAccess.length > 0 ? (
                    k.emailAccess.map((email) => {
                      const emailInfo = accessibleEmails.find(
                        (ae) => ae.email.toLowerCase() === email.toLowerCase()
                      );
                      return (
                        <span
                          key={email}
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                            emailInfo?.type === 'delegated'
                              ? 'bg-indigo-50 text-indigo-700 ring-indigo-600/20'
                              : 'bg-green-50 text-green-700 ring-green-600/20'
                          }`}
                        >
                          {email}
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-xs text-red-600">No email access granted</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    startTransition(() => rollProxyKey(k.id))
                  }
                  disabled={isPending}
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Roll
                </button>
                <button
                  onClick={() =>
                    startTransition(() => revokeProxyKey(k.id))
                  }
                  disabled={isPending}
                  className="text-sm font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {revokedKeys.length > 0 && (
        <details className="mt-4">
          <summary className="text-sm text-gray-800 cursor-pointer hover:text-gray-900">
            Show {revokedKeys.length} revoked key{revokedKeys.length > 1 ? "s" : ""}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {revokedKeys.map((k) => (
              <div
                key={k.id}
                className="bg-gray-50 border border-gray-200 rounded-lg p-3 opacity-60"
              >
                <p className="font-medium text-gray-700 line-through">{k.label}</p>
                <SecretKeyDisplay apiKey={k.key} className="text-xs text-gray-500 bg-transparent !px-0 !py-0" iconSize={12} />
                <p className="text-xs text-red-600 mt-1">
                  Revoked {k.revokedAt ? new Date(k.revokedAt).toLocaleDateString() : ""}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
      </>
      )}

      {/* Create Key Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 transition-all">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
            {created ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-1">Profile created</h3>
                  <p className="text-sm text-slate-800">
                    Your key has been copied to your clipboard. Point your agent at the
                    endpoint below and send the key as a Bearer token.
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">API key</p>
                  <SecretKeyDisplay apiKey={created.proxyKey} className="w-full text-sm text-slate-700" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">Endpoint</p>
                  <pre className="mt-1.5 whitespace-pre-wrap break-all rounded-xs border border-border bg-muted px-2 py-1.5 font-mono text-xs text-slate-700">{`${PROXY_ENDPOINT}
Python:  client_options={"api_endpoint": "${PROXY_ENDPOINT}/gmail/v1"}
Node.js: rootUrl: "${PROXY_ENDPOINT}/"
cURL:    ${PROXY_ENDPOINT}/gmail/v1/users/me/messages`}</pre>
                </div>
                <div className="mt-2 flex flex-wrap justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => downloadSaJson(created.proxyKey, created.privateKey)}
                    title="Advanced — requires a rootUrl override in your code"
                    className="px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                  >
                    Download Service Account JSON
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-md shadow-sm transition-colors"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
            <>
            <h3 className="text-xl font-bold text-slate-900 mb-1">
              Create API Key
            </h3>
            <p className="text-sm text-slate-800 mb-5">
              Label this key and select which email accounts it can access.
            </p>

            <form action={onSubmit} className="flex flex-col gap-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Key Label
                </label>
                <input
                  type="text"
                  name="label"
                  required
                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                  placeholder="e.g. Claude Personal Assistant"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">
                  Email Access
                </label>
                {accessibleEmails.length === 0 ? (
                  <p className="text-sm text-amber-700 bg-amber-50 p-2 rounded">
                    No accessible emails. Connect your Google account first.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accessibleEmails.map((ae) => (
                      <label
                        key={ae.email}
                        className={`flex items-center gap-2 text-sm ${!isSelectable(ae) ? 'opacity-50 text-slate-500' : 'text-slate-800'}`}
                        title={!isSelectable(ae) ? "Google Account not securely linked. Open Account Settings to grant access." : ""}
                      >
                        <input
                          type="checkbox"
                          name="emails"
                          value={ae.email}
                          checked={selectedEmails.includes(ae.email)}
                          onChange={(e) => setSelectedEmails(prev =>
                            e.target.checked ? [...prev, ae.email] : prev.filter(x => x !== ae.email))}
                          disabled={!isSelectable(ae)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                        <span className={!isSelectable(ae) ? 'line-through' : ''}>{ae.email}</span>
                        {ae.type === 'delegated' && (
                          <span className="text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
                            Delegated
                          </span>
                        )}
                        {ae.type === 'own' && (
                          <span className="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                            You
                          </span>
                        )}
                        {!isSelectable(ae) && (
                           <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 ml-auto">
                              Action Required: Connect Google
                           </span>
                        )}
                      </label>
                    ))}
                    {selectedEmails.length === 0 && (
                      <p className="text-xs text-amber-700">
                        Select at least one mailbox — a profile without one cannot read or send any mail.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {createError && (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {createError}
                </p>
              )}
              <div className="mt-2 flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending || selectedEmails.length === 0}
                  className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-md disabled:opacity-50 shadow-sm transition-colors"
                >
                  {isPending ? "Creating..." : "Create Key"}
                </button>
              </div>
            </form>
            </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
