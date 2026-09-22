'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Card, CardHeader, Badge, EmptyState, buttonPrimary, buttonSecondary, buttonDanger } from '@/components/ui';
import { assignRulesToKey, unassignRuleFromKey, revokeProxyKey, setSheetRulePermission, exposeFilesFromPicker, applyRecommendedSecurityRules, enableSendToAnyone } from './actions';
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS, kindForService, type DriveFileKind } from '@/lib/driveFileKinds';
import { useGooglePicker, PickedSheet } from './useGooglePicker';

/** access_rules.service values that are per-file grants (not Gmail rules). */
const FILE_SERVICES: string[] = ACTIVE_DRIVE_FILE_KINDS.map(k => DRIVE_FILE_KINDS[k].service);
import { EditRuleButton } from './EditRuleButton';
import { DeleteRuleButton } from './DeleteRuleButton';
import { RuleControls } from './RuleControls';
import { KeyControls, SecretKeyDisplay } from './KeyControls';
import { DirectoryCta } from '../DirectoryCta';
import { slugifyProfileLabel } from '@/lib/profileSlugs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  key: string;
  label: string;
  isDefault: boolean;
  createdAt: string;
  revokedAt: string | null;
  emailAccess: string[];
}

export interface Rule {
  id: string;
  ruleName: string;
  service: string;
  actionType: string;
  regexPattern: string | null;
  targetResourceId: string | null;
  resourceName: string | null;
  targetEmail: string | null;
  assignedKeyIds: string[];
}

interface Connection {
  id: string;
  clientId: string;
  clientName: string | null;
  nickname: string | null;
  status: 'pending' | 'approved' | 'blocked';
  proxyKeyId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  // Set when the connection was provisioned via the partner handoff
  // (/oauth/authorize consent) rather than agent-initiated DCR.
  partnerApp?: { name: string; logoUrl: string | null } | null;
}

interface AccessibleEmail {
  email: string;
  type: 'own' | 'delegated';
  delegationId?: string;
  hasCompleteGoogleAccess?: boolean;
}

/** Google-side grant state for one file, from the verify endpoints. */
interface GrantState {
  state: string;
  /** Live Drive filename when state is 'ok' — fresher than resourceName. */
  title?: string | null;
}

function timeAgo(date: string | null): string {
  if (!date) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** A rule with no assignments at all applies to every profile. */
const isGlobal = (rule: Rule) => rule.assignedKeyIds.length === 0;

// ─── Root ───────────────────────────────────────────────────────────────────

export function AgentProfilesView({
  profiles,
  rules,
  accessibleEmails,
  mcpEndpoint,
  hasCompleteGoogleAccess,
  activeId,
}: {
  profiles: Profile[];
  rules: Rule[];
  accessibleEmails: AccessibleEmail[];
  mcpEndpoint: string;
  hasCompleteGoogleAccess: boolean;
  /** Selected profile — owned by the route (/dashboard/agents/[slug]), not
   *  component state, so tabs are real links and profiles are bookmarkable. */
  activeId: string | null;
}) {
  const activeProfiles = useMemo(() => profiles.filter(p => !p.revokedAt), [profiles]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  // Bumped by the "Create a new rule…" action inside the Apply-a-rule picker.
  const [createRuleSignal, setCreateRuleSignal] = useState(0);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/connections');
      const data = await res.json();
      setConnections(data.connections || []);
    } catch (e) {
      console.error('Failed to fetch connections:', e);
    } finally {
      setConnectionsLoading(false);
    }
  }, []);

  // fileId → Google-side grant state per kind. A rule can exist without
  // Google ever having shared the file (approved via magic link, never
  // picked) — those rows get a "Needs Google access" chip (capability 17
  // A6 names the profile card, not just the Accounts manager). Verification
  // failing entirely degrades to no chips, never a broken card. `title` is
  // the LIVE Drive filename, fetched by the same verification call — render
  // it ahead of the stored (grant-time) resourceName so Drive renames show.
  const [grantStates, setGrantStates] = useState<Partial<Record<DriveFileKind, Record<string, GrantState>>>>({});
  useEffect(() => {
    let cancelled = false;
    const load = async (path: string): Promise<Record<string, GrantState>> => {
      try {
        const res = await fetch(path);
        const data = await res.json();
        return data.grants ?? {};
      } catch {
        return {};
      }
    };
    Promise.all(ACTIVE_DRIVE_FILE_KINDS.map(k => load(DRIVE_FILE_KINDS[k].verifyPath)))
      .then(states => {
        if (cancelled) return;
        setGrantStates(Object.fromEntries(ACTIVE_DRIVE_FILE_KINDS.map((k, i) => [k, states[i]])));
      });
    return () => { cancelled = true; };
  }, [rules]);

  useEffect(() => { fetchConnections(); }, [fetchConnections]);

  const active = activeProfiles.find(p => p.id === activeId) ?? null;
  const pending = connections.filter(c => c.status === 'pending');

  // Per-kind file rules (sheets / docs / slides) and the Gmail remainder.
  // Each FilesRulesCard owns its own Google Picker hook for its kind (the
  // hook also consumes the ?autoOpenPicker= return leg of the first-time
  // consent redirect for that kind, with the profile id carried as context).
  const { fileRulesByKind, gmailRules } = useMemo(() => {
    const empty = Object.fromEntries(ACTIVE_DRIVE_FILE_KINDS.map(k => [k, [] as Rule[]])) as Record<DriveFileKind, Rule[]>;
    if (!active) return { fileRulesByKind: empty, gmailRules: [] as Rule[] };
    const forProfile = rules.filter(r => isGlobal(r) || r.assignedKeyIds.includes(active.id));
    const byKind = { ...empty };
    for (const r of forProfile) {
      const k = kindForService(r.service);
      if (k) byKind[k] = [...byKind[k], r];
    }
    return {
      fileRulesByKind: byKind,
      gmailRules: forProfile.filter(r => !FILE_SERVICES.includes(r.service)),
    };
  }, [rules, active]);

  const activeKeyList = activeProfiles.map(p => ({ id: p.id, label: p.label }));
  const emailList = accessibleEmails.map(e => e.email);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {pending.length > 0 && (
        <PendingBanner count={pending.length} first={pending[0]} />
      )}

      <RecentConnectionsBanner connections={connections} rules={rules} />

      <ProfileTabs
        profiles={activeProfiles}
        activeId={activeId}
        accessibleEmails={accessibleEmails}
        profilesForKeyControls={profiles}
      />

      {!active ? (
        <Card className="p-10 text-center">
          <h2 className="text-lg font-bold text-foreground">No agent profiles yet</h2>
          <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
            A profile is a scoped identity you hand to one agent. Create one to start
            granting access — until then, every agent is denied by default.
          </p>
          <div className="mt-5 inline-block">
            <KeyControls accessibleEmails={accessibleEmails} existingKeys={[]} />
          </div>
        </Card>
      ) : (
        <>
          <ProfileHeader profile={active} />

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 items-start">
            <div className="space-y-6 min-w-0">
              {ACTIVE_DRIVE_FILE_KINDS.map(kind => (
                <FilesRulesCard
                  key={kind}
                  kind={kind}
                  profileId={active.id}
                  rules={fileRulesByKind[kind]}
                  grantStates={grantStates[kind] ?? {}}
                />
              ))}

              <GmailRulesCard
                profileId={active.id}
                rules={gmailRules}
                allRules={rules}
                accessibleEmails={emailList}
                activeKeys={activeKeyList}
                isDefaultProfile={active.isDefault || active.label === 'Default Profile'}
                onCreateNew={() => setCreateRuleSignal(n => n + 1)}
              />
            </div>

            <div className="space-y-6 min-w-0">
              <ConnectedAgentsCard
                profileId={active.id}
                profiles={activeProfiles}
                connections={connections}
                loading={connectionsLoading}
                onChanged={fetchConnections}
              />

              <GmailAccessCard
                profile={active}
                accessibleEmails={accessibleEmails}
                hasCompleteGoogleAccess={hasCompleteGoogleAccess}
              />

              <McpConnectCard endpoint={mcpEndpoint} profile={active} />
            </div>
          </div>

          {/* Rule creation lives outside the per-service cards because a new rule
              may target either service. */}
          <Card>
            <CardHeader
              title="Create a rule"
              subtitle="Rules are reusable — create once, then apply to any profile."
              action={
                <RuleControls
                  accessibleEmails={emailList}
                  activeKeys={activeKeyList}
                  hasBlacklistRules={rules.some(r => r.actionType === 'read_blacklist')}
                  openSignal={createRuleSignal}
                />
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Pending banner ─────────────────────────────────────────────────────────

function PendingBanner({ count, first }: { count: number; first: Connection }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-warning-foreground bg-warning px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[13px] font-bold text-warning-foreground">
          {count === 1 ? '1 agent waiting for approval' : `${count} agents waiting for approval`}
        </p>
        <p className="text-xs text-warning-foreground/80 mt-0.5 truncate">
          &ldquo;{first.clientName || first.clientId}&rdquo; connected {timeAgo(first.createdAt).toLowerCase()}.
          Attach it to a profile to grant access.
        </p>
      </div>
      <a href="#connected-agents" className={`${buttonSecondary} shrink-0`}>
        Attach to a profile
      </a>
    </div>
  );
}

// ─── Recent auto-attached connections banner (instant-start) ────────────────
// New MCP connections auto-attach to the Default Profile read-only. This
// notice keeps the user informed after the fact and carries the one-click
// sensitive-mail shield CTA (shield is OFF by default — decision log in
// connector-growth_v1.md).

function RecentConnectionsBanner({ connections, rules }: { connections: Connection[]; rules: Rule[] }) {
  const [dismissed, setDismissed] = useState(false);
  const [enabling, setEnabling] = useState(false);

  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const recent = connections.filter(
    c => c.status === 'approved' && new Date(c.createdAt).getTime() > sevenDaysAgo,
  );
  const hasShield = rules.some(r => !FILE_SERVICES.includes(r.service) && r.actionType === 'read_blacklist');

  if (dismissed || recent.length === 0) return null;

  const label = recent.length === 1
    ? `"${recent[0].nickname || recent[0].clientName || recent[0].clientId}" connected ${timeAgo(recent[0].createdAt).toLowerCase()}`
    : `${recent.length} agents connected recently`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary-muted px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[13px] font-bold text-foreground">
          {label} with safe defaults: it can read this account&apos;s mail (and inboxes delegated to you), and cannot send, edit, or delete.
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {hasShield
            ? 'Your sensitive-mail shield rules apply to it. Review or block it below.'
            : 'The sensitive-mail shield (blocks 2FA codes, password resets, sign-in alerts) is OFF. Enable it in one click, or review the agent below.'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {!hasShield && (
          <button
            onClick={async () => {
              setEnabling(true);
              try { await applyRecommendedSecurityRules(); } finally { setEnabling(false); }
            }}
            disabled={enabling}
            className="rounded-sm bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {enabling ? 'Enabling…' : 'Enable sensitive-mail shield'}
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

function ProfileTabs({
  profiles,
  activeId,
  accessibleEmails,
  profilesForKeyControls,
}: {
  profiles: Profile[];
  activeId: string | null;
  accessibleEmails: AccessibleEmail[];
  profilesForKeyControls: Profile[];
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border overflow-x-auto">
      {/* Tabs are real links to /dashboard/agents/[slug] — back button,
          middle-click, and bookmarking work for free. */}
      <div role="tablist" className="flex items-center gap-1 min-w-0">
        {profiles.map(p => {
          const isActive = p.id === activeId;
          const slug = slugifyProfileLabel(p.label);
          return (
            <Link
              key={p.id}
              role="tab"
              aria-selected={isActive}
              // A legacy label that slugifies to nothing has no route of its
              // own; /dashboard renders it inline as the fallback selection.
              href={slug ? `/dashboard/agents/${slug}` : '/dashboard'}
              className={`whitespace-nowrap px-3.5 py-2.5 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
      <div className="ml-auto pl-3 pb-1.5 shrink-0">
        <KeyControls
          variant="button"
          triggerLabel="+ New profile"
          accessibleEmails={accessibleEmails}
          existingKeys={profilesForKeyControls.map(p => ({
            id: p.id,
            key: p.key,
            label: p.label,
            revokedAt: p.revokedAt ? new Date(p.revokedAt) : null,
            expiresAt: null,
            createdAt: new Date(p.createdAt),
            emailAccess: p.emailAccess,
          }))}
        />
      </div>
    </div>
  );
}

// ─── Profile header ─────────────────────────────────────────────────────────

function ProfileHeader({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [revoking, setRevoking] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary bg-primary-muted text-[13px] font-bold text-primary">
          {profile.label.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-foreground truncate">{profile.label}</h1>
            <Badge tone="success">● Active</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Created {new Date(profile.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[13px] text-muted-foreground">
              Revoke this key? Agents using it lose access immediately.
            </span>
            <button
              className={buttonDanger}
              disabled={revoking}
              onClick={async () => {
                setRevoking(true);
                try {
                  await revokeProxyKey(profile.id);
                  // This profile's route just stopped existing — land on the
                  // dashboard, which redirects to the next default profile.
                  router.push('/dashboard');
                } finally {
                  setRevoking(false);
                  setConfirming(false);
                }
              }}
            >
              {revoking ? 'Revoking…' : 'Confirm revoke'}
            </button>
            <button className={buttonSecondary} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className={buttonDanger} onClick={() => setConfirming(true)}>
            Revoke key
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Per-file (Sheets / Docs) rules ─────────────────────────────────────────

// Permission options per kind, from the descriptor's action types.
// Built over EVERY kind in the descriptor (not just the active ones) so the
// Record type below is honest — a stub kind's rule can never index undefined.
const FILE_PERMISSIONS = Object.fromEntries((Object.keys(DRIVE_FILE_KINDS) as DriveFileKind[]).map(k => {
  const t = DRIVE_FILE_KINDS[k].actionTypes;
  return [k, [
    { value: t.read, label: 'Read Only', tone: 'info' as const },
    { value: t.readWrite, label: 'Read & Write', tone: 'success' as const },
    { value: t.block, label: 'Blocked', tone: 'error' as const },
  ]];
})) as Record<DriveFileKind, { value: string; label: string; tone: 'info' | 'success' | 'error' }[]>;

const FILE_CARD_COPY: Record<DriveFileKind, { title: string; subtitle: string; expose: string; empty: React.ReactNode }> = {
  sheet: {
    title: 'Google Sheets Rules',
    subtitle: 'Spreadsheets this profile can reach',
    expose: '+ Expose a sheet',
    empty: <>No sheets exposed to this profile. Click &quot;+ Expose a sheet&quot; to pick
      spreadsheets from Google Drive.</>,
  },
  doc: {
    title: 'Google Docs Rules',
    subtitle: 'Documents this profile can reach',
    expose: '+ Expose a doc',
    empty: <>No docs exposed to this profile. Click &quot;+ Expose a doc&quot; to pick
      documents from Google Drive.</>,
  },
  slide: {
    title: 'Google Slides Rules',
    subtitle: 'Presentations this profile can reach',
    expose: '+ Expose a presentation',
    empty: <>No presentations exposed to this profile. Click &quot;+ Expose a presentation&quot; to pick
      Google Slides decks from Google Drive.</>,
  },
};

function FilesRulesCard({
  kind,
  profileId,
  rules,
  grantStates,
}: {
  kind: DriveFileKind;
  profileId: string;
  rules: Rule[];
  /** fileId → Google-side grant state; missing entries mean "unknown" (no chip). */
  grantStates: Record<string, GrantState>;
}) {
  const d = DRIVE_FILE_KINDS[kind];
  const setup = { path: d.setupPath, idParam: d.setupIdParam, noun: d.shortNoun };
  // "+ Expose a …" opens the Google Picker directly — picking a file is
  // the whole flow, whether or not it was already exposed elsewhere (the
  // server action merges assignments instead of narrowing them). No detour
  // through the Accounts page. The picker hook is per card = per kind.
  const handlePicked = useCallback(async (files: PickedSheet[], context?: string) => {
    try {
      await exposeFilesFromPicker(kind, files, context || undefined);
    } catch (e) {
      console.error(`Failed to save exposed ${d.noun}s:`, e);
    }
  }, [kind, d.noun]);
  const { triggerAddSheets: onExposeKind, isLoading: exposing, pickerError } = useGooglePicker(handlePicked, kind);
  const onExpose = () => onExposeKind(profileId);
  const copy = FILE_CARD_COPY[kind];

  return (
    <Card tone={d.tone}>
      <CardHeader
        title={copy.title}
        subtitle={copy.subtitle}
        action={
          <button className={buttonSecondary} onClick={onExpose} disabled={exposing}>
            {exposing ? 'Opening Google Picker…' : copy.expose}
          </button>
        }
      />
      <div className="px-5 pb-5 space-y-2">
        {pickerError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground [overflow-wrap:anywhere]" data-testid="picker-error">
            <span className="font-semibold">Google flow failed: </span>{pickerError}{" "}
            <a href="/dashboard/accounts" className="underline hover:opacity-80">Open the Accounts page</a>
          </div>
        )}
        {rules.length === 0 ? (
          <EmptyState>
            {copy.empty}
          </EmptyState>
        ) : (
          rules.map(rule => {
            const displayName =
              (rule.targetResourceId && grantStates[rule.targetResourceId]?.title) ||
              rule.resourceName || rule.ruleName;
            return (
            <div
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {displayName}
                  </span>
                  {isGlobal(rule) && <Badge tone="neutral">Global</Badge>}
                  {rule.targetResourceId && grantStates[rule.targetResourceId]?.state === 'missing' && (
                    <a
                      href={`${setup.path}?${setup.idParam}=${encodeURIComponent(rule.targetResourceId)}${displayName !== rule.ruleName ? `&name=${encodeURIComponent(displayName)}` : ''}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning-foreground/30 bg-warning px-2 py-0.5 text-[11px] font-semibold text-warning-foreground hover:opacity-80"
                      title={`FGAC has this rule, but Google hasn't shared the ${setup.noun} with FGAC yet — agents get errors until you pick it in the Google Picker.`}
                    >
                      ⚠ Needs Google access — finish setup
                    </a>
                  )}
                </div>
                {rule.targetResourceId && (
                  <code className="mt-1 block truncate font-mono text-[11px] text-subtle">
                    {rule.targetResourceId}
                  </code>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <FilePermissionSelect kind={kind} rule={rule} displayName={displayName} />
                {!isGlobal(rule) && <DetachRuleButton profileId={profileId} rule={rule} />}
              </div>
            </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

/**
 * Saves on change. The select is recolored to match the permission so the
 * access level of every file is legible at a glance without reading labels.
 */
function FilePermissionSelect({ kind, rule, displayName }: { kind: DriveFileKind; rule: Rule; displayName?: string }) {
  const [value, setValue] = useState(rule.actionType);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const permissions = FILE_PERMISSIONS[kind];
  const tone = permissions.find(p => p.value === value)?.tone ?? 'neutral';
  const toneClass = {
    info: 'border-info-foreground/30 bg-info text-info-foreground',
    success: 'border-success-foreground/30 bg-success text-success-foreground',
    error: 'border-error-foreground/30 bg-error text-error-foreground',
    neutral: 'border-border bg-muted text-muted-foreground',
  }[tone];

  return (
    <div className="flex items-center gap-2">
      {failed && <span className="text-[11px] text-destructive">Couldn&apos;t save</span>}
      <select
        value={value}
        disabled={busy}
        aria-label={`Permission for ${displayName || rule.resourceName || rule.ruleName}`}
        onChange={async e => {
          const next = e.target.value;
          const previous = value;
          setValue(next);          // optimistic
          setFailed(false);
          setBusy(true);
          try {
            await setSheetRulePermission(rule.id, next);
          } catch {
            setValue(previous);    // roll back on failure
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-60 ${toneClass}`}
      >
        {permissions.map(p => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Gmail rules ────────────────────────────────────────────────────────────

function GmailRulesCard({
  profileId,
  rules,
  allRules,
  accessibleEmails,
  activeKeys,
  isDefaultProfile,
  onCreateNew,
}: {
  profileId: string;
  rules: Rule[];
  allRules: Rule[];
  accessibleEmails: string[];
  activeKeys: { id: string; label: string }[];
  isDefaultProfile: boolean;
  onCreateNew: () => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [enablingSendAll, setEnablingSendAll] = useState(false);

  // The one-click escape hatch from per-recipient whitelisting. Shown on the
  // Default Profile until an all-recipients send rule covers it.
  const hasSendAll = rules.some(
    r => r.actionType === 'send_whitelist' && r.regexPattern === '*',
  );

  // Only rules that exist but are not yet on this profile can be applied.
  // Global rules are excluded — they already apply everywhere.
  const applicable = allRules.filter(
    r => !FILE_SERVICES.includes(r.service) && !isGlobal(r) && !r.assignedKeyIds.includes(profileId),
  );

  return (
    <Card tone="gmail">
      <CardHeader
        title="Gmail Rules"
        subtitle="Rules that govern this profile's access to mail"
        action={
          <div className="relative">
            <button className={buttonSecondary} onClick={() => setPopoverOpen(v => !v)}>
              + Apply a rule
            </button>
            {popoverOpen && (
              <ApplyRulePopover
                profileId={profileId}
                candidates={applicable}
                emptyMessage={
                  allRules.some(r => !FILE_SERVICES.includes(r.service))
                    ? 'Every existing Gmail rule already applies to this profile.'
                    : "You haven't created any Gmail rules yet."
                }
                onCreateNew={onCreateNew}
                onClose={() => setPopoverOpen(false)}
              />
            )}
          </div>
        }
      />
      <div className="px-5 pb-5 space-y-2">
        {isDefaultProfile && !hasSendAll && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-card px-4 py-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              Don&apos;t want to whitelist recipients one at a time? Let this
              profile email anyone — revocable any time by deleting the rule.
            </p>
            <button
              className={buttonSecondary}
              disabled={enablingSendAll}
              onClick={async () => {
                setEnablingSendAll(true);
                try { await enableSendToAnyone(profileId); } finally { setEnablingSendAll(false); }
              }}
            >
              {enablingSendAll ? 'Enabling…' : 'Enable sending to anyone'}
            </button>
          </div>
        )}
        {rules.length === 0 ? (
          <EmptyState>
            No Gmail rules on this profile. With no rules, access is denied by default.
          </EmptyState>
        ) : (
          rules.map(rule => (
            <div
              key={rule.id}
              className="flex items-start justify-between gap-4 rounded-sm border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{rule.ruleName}</span>
                  <RuleTypeBadge actionType={rule.actionType} />
                  {isGlobal(rule) && <Badge tone="neutral">Global</Badge>}
                </div>
                {rule.regexPattern && (
                  <code className="mt-1.5 block truncate rounded-xs bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {rule.regexPattern}
                  </code>
                )}
                <p className="mt-1 text-[11px] text-subtle">
                  {rule.targetEmail ? `Scoped to ${rule.targetEmail}` : 'All accessible mailboxes'}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <EditRuleButton rule={rule} accessibleEmails={accessibleEmails} activeKeys={activeKeys} />
                {!isGlobal(rule) && <DetachRuleButton profileId={profileId} rule={rule} />}
                <DeleteRuleButton id={rule.id} />
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

function RuleTypeBadge({ actionType }: { actionType: string }) {
  if (actionType === 'read_blacklist') return <Badge tone="error">Read Blacklist</Badge>;
  if (actionType === 'send_whitelist') return <Badge tone="success">Send Whitelist</Badge>;
  return <Badge tone="neutral">{actionType}</Badge>;
}

/**
 * Detaching the last assignment would silently promote the rule to global —
 * i.e. widen its reach instead of narrowing it. That inversion is surprising
 * enough to warrant an inline confirm.
 */
function DetachRuleButton({ profileId, rule }: { profileId: string; rule: Rule }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const wouldBecomeGlobal = rule.assignedKeyIds.length === 1;

  if (!confirming) {
    return (
      <button
        className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
        onClick={() => setConfirming(true)}
      >
        Detach
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {wouldBecomeGlobal && (
        <span className="text-[11px] text-warning-foreground max-w-[180px]">
          This is the last profile using it — detaching makes the rule apply to <em>all</em> profiles.
        </span>
      )}
      <button
        className="text-[11px] font-semibold text-destructive hover:opacity-80 disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await unassignRuleFromKey(profileId, rule.id);
          } finally {
            setBusy(false);
            setConfirming(false);
          }
        }}
      >
        {busy ? '…' : 'Confirm'}
      </button>
      <button
        className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
    </div>
  );
}

function ApplyRulePopover({
  profileId,
  candidates,
  onClose,
  onCreateNew,
  emptyMessage = 'Every existing rule already applies here.',
}: {
  profileId: string;
  candidates: Rule[];
  onClose: () => void;
  onCreateNew?: () => void;
  emptyMessage?: React.ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const filtered = candidates.filter(r =>
    r.ruleName.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      ref={ref}
      className="absolute right-0 z-20 mt-2 w-[320px] rounded-lg border border-border bg-popover shadow-lg"
    >
      <div className="border-b border-border px-5 py-3">
        <p className="text-[13px] font-bold text-popover-foreground">Apply an existing rule</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Rules are shared across profiles.
        </p>
      </div>

      <div className="px-5 pt-3 pb-1">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search rules…"
          autoFocus
          className="w-full rounded-sm border border-input bg-card px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>

      <div className="max-h-56 overflow-y-auto px-5 py-2 space-y-1">
        {filtered.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-muted-foreground">
            {candidates.length === 0 ? emptyMessage : 'No rules match that search.'}
          </p>
        ) : (
          filtered.map(rule => (
            <label
              key={rule.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-xs px-2 py-1.5 hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.includes(rule.id)}
                onChange={e =>
                  setSelected(prev =>
                    e.target.checked ? [...prev, rule.id] : prev.filter(id => id !== rule.id),
                  )
                }
                className="h-3.5 w-3.5 accent-primary"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-popover-foreground">
                {rule.ruleName}
              </span>
              <RuleTypeBadge actionType={rule.actionType} />
            </label>
          ))
        )}
      </div>

      {/* The design specifies a create path inside the picker: if the rule you
          want does not exist yet, you should not have to close this, scroll to
          the bottom of the page, and lose your selection. */}
      {onCreateNew && (
        <div className="border-t border-border px-5 py-2.5">
          <button
            onClick={() => { onClose(); onCreateNew(); }}
            className="text-[12px] font-semibold text-primary hover:underline"
          >
            + Create a new rule…
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 rounded-b-lg border-t border-border bg-muted px-5 py-3">
        <span className="text-[11px] text-muted-foreground">
          {selected.length} selected
        </span>
        <div className="flex items-center gap-2">
          <button className={buttonSecondary} onClick={onClose}>Cancel</button>
          <button
            className={buttonPrimary}
            disabled={selected.length === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await assignRulesToKey(profileId, selected);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Connected agents ───────────────────────────────────────────────────────

function ConnectedAgentsCard({
  profileId,
  profiles,
  connections,
  loading,
  onChanged,
}: {
  profileId: string;
  profiles: Profile[];
  connections: Connection[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (connectionId: string, action: string, extra?: Record<string, string>) => {
    setBusyId(connectionId);
    try {
      await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, action, ...extra }),
      });
      await onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const mine = connections.filter(c => c.status === 'approved' && c.proxyKeyId === profileId);
  const pending = connections.filter(c => c.status === 'pending');
  // Blocked connections are not profile-scoped: blocking clears nothing, but a
  // blocked agent has no key binding to filter on, so show them on every tab
  // rather than hiding them somewhere unreachable.
  const blocked = connections.filter(c => c.status === 'blocked');

  return (
    <Card className="scroll-mt-24" >
      <div id="connected-agents" />
      <CardHeader
        title="Connected Agents"
        subtitle="Authenticated agents using this profile"
      />
      <div className="px-5 pb-5 space-y-2.5">
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-14 animate-pulse rounded-sm bg-muted" />
            <div className="h-14 animate-pulse rounded-sm bg-muted" />
          </div>
        ) : (
          <>
            {mine.length === 0 && pending.length === 0 && blocked.length === 0 && (
              <EmptyState>
                No agents attached yet. Connect one with the endpoint below and it will
                appear here for approval.
              </EmptyState>
            )}

            {mine.map(conn => (
              <ApprovedAgentCard
                key={conn.id}
                conn={conn}
                busy={busyId === conn.id}
                onRename={nickname => act(conn.id, 'update_nickname', { nickname })}
                onDetach={() => act(conn.id, 'block')}
              />
            ))}

            {pending.map(conn => (
              <PendingAgentCard
                key={conn.id}
                conn={conn}
                profiles={profiles}
                defaultProfileId={profileId}
                busy={busyId === conn.id}
                onApprove={(keyId, nickname) => act(conn.id, 'approve', { proxyKeyId: keyId, nickname })}
                onBlock={() => act(conn.id, 'block')}
              />
            ))}

            {blocked.map(conn => (
              <div key={conn.id} className="rounded-sm border border-border bg-muted p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-semibold text-muted-foreground line-through">
                    {conn.nickname || conn.clientName || conn.clientId}
                  </span>
                  <Badge tone="error">Blocked</Badge>
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <button
                    className="text-[11px] font-semibold text-primary hover:underline disabled:opacity-50"
                    disabled={busyId === conn.id}
                    onClick={() => act(conn.id, 'approve', { proxyKeyId: profileId })}
                  >
                    {busyId === conn.id ? '…' : 'Unblock into this profile'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}

/** Approved agent. Nickname is editable inline — click the name to rename. */
function ApprovedAgentCard({
  conn,
  busy,
  onRename,
  onDetach,
}: {
  conn: Connection;
  busy: boolean;
  onRename: (nickname: string) => void;
  onDetach: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conn.nickname || conn.clientName || '');

  return (
    <div className="rounded-sm border border-border bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); if (draft.trim()) onRename(draft.trim()); }}
            onKeyDown={e => {
              if (e.key === 'Enter') { setEditing(false); if (draft.trim()) onRename(draft.trim()); }
              if (e.key === 'Escape') { setEditing(false); setDraft(conn.nickname || conn.clientName || ''); }
            }}
            className="min-w-0 flex-1 rounded-xs border border-input bg-card px-1.5 py-0.5 text-[13px] font-semibold text-foreground"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Rename"
            className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:underline"
          >
            {conn.nickname || conn.clientName || conn.clientId}
          </button>
        )}
        <span className="flex items-center gap-1.5">
          {conn.partnerApp && <Badge tone="info">Partner · {conn.partnerApp.name}</Badge>}
          <Badge tone="success">Approved</Badge>
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-subtle">Last used {timeAgo(conn.lastUsedAt)}</span>
        <button
          className="text-[11px] font-semibold text-muted-foreground hover:text-destructive disabled:opacity-50"
          disabled={busy}
          onClick={onDetach}
        >
          {busy ? '…' : 'Detach'}
        </button>
      </div>
    </div>
  );
}

function PendingAgentCard({
  conn,
  profiles,
  defaultProfileId,
  busy,
  onApprove,
  onBlock,
}: {
  conn: Connection;
  profiles: Profile[];
  defaultProfileId: string;
  busy: boolean;
  onApprove: (keyId: string, nickname: string) => void;
  onBlock: () => void;
}) {
  const [keyId, setKeyId] = useState(defaultProfileId);
  const [nickname, setNickname] = useState(conn.clientName || '');

  return (
    <div className="rounded-sm border border-warning-foreground bg-warning p-3.5 animate-pulse-subtle">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-warning-foreground">
          {conn.clientName || conn.clientId}
        </span>
        <Badge tone="warning">Pending</Badge>
      </div>
      <p className="mt-0.5 text-[11px] text-warning-foreground/80">
        Connected {timeAgo(conn.createdAt).toLowerCase()}
      </p>

      <div className="mt-3 space-y-2">
        <input
          type="text"
          value={nickname}
          onChange={e => setNickname(e.target.value)}
          placeholder="Nickname (e.g. My Work Agent)"
          className="w-full rounded-xs border border-input bg-card px-2 py-1.5 text-[12px] text-foreground placeholder:text-subtle"
        />
        <select
          value={keyId}
          onChange={e => setKeyId(e.target.value)}
          className="w-full rounded-xs border border-input bg-card px-2 py-1.5 text-[12px] text-foreground"
        >
          {profiles.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          className={`${buttonPrimary} flex-1`}
          disabled={busy || !keyId}
          onClick={() => onApprove(keyId, nickname)}
        >
          {busy ? '…' : 'Attach to this profile'}
        </button>
        <button className={buttonDanger} disabled={busy} onClick={onBlock}>
          Block
        </button>
      </div>
    </div>
  );
}

// ─── Gmail account access ───────────────────────────────────────────────────

function GmailAccessCard({
  profile,
  accessibleEmails,
  hasCompleteGoogleAccess,
}: {
  profile: Profile;
  accessibleEmails: AccessibleEmail[];
  hasCompleteGoogleAccess: boolean;
}) {
  return (
    <Card>
      <CardHeader title="Gmail Account Access" subtitle="Mailboxes this profile can reach" />
      <div className="px-5 pb-5 space-y-2">
        {profile.emailAccess.length === 0 ? (
          <EmptyState>This profile has no mailbox access.</EmptyState>
        ) : (
          profile.emailAccess.map(email => {
            const meta = accessibleEmails.find(e => e.email === email);
            const isOwn = meta?.type === 'own';
            const healthy = !isOwn || hasCompleteGoogleAccess;
            return (
              <div
                key={email}
                className="flex items-center justify-between gap-2 rounded-sm border border-border bg-card px-3 py-2"
              >
                <span className="min-w-0 truncate text-[13px] text-foreground">{email}</span>
                {healthy ? (
                  <Badge tone={isOwn ? 'success' : 'primary'}>{isOwn ? 'You' : 'Delegated'}</Badge>
                ) : (
                  <Badge tone="error">Reconnect</Badge>
                )}
              </div>
            );
          })
        )}
        <p className="pt-1 text-xs leading-relaxed text-subtle">
          {/* Legacy default keys are only flagged at their next MCP connection
              (ensureDefaultProfile adoption), so match on the label too. */}
          {profile.isDefault || profile.label === 'Default Profile'
            ? 'Inboxes other people delegate to you are added here automatically.'
            : 'Mailboxes are chosen when a profile is created; inboxes delegated to you attach to your Default Profile automatically.'}{' '}
          <Link
            href="/use-cases/multiple-gmail-accounts"
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            How to set up multiple Gmail accounts
          </Link>
        </p>
      </div>
    </Card>
  );
}

// ─── MCP endpoint ───────────────────────────────────────────────────────────

function CopyRow({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex w-full items-center justify-between gap-2 rounded-sm bg-surface-inverse px-3 py-2 text-left"
    >
      <code className="min-w-0 truncate font-mono text-[11px] text-surface-inverse-foreground">
        {display ?? value}
      </code>
      <span className="shrink-0 text-[11px] font-semibold text-surface-inverse-foreground">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

function McpConnectCard({ endpoint, profile }: { endpoint: string; profile: Profile }) {
  // Every profile is addressable by its label slug; the bare endpoint keeps
  // meaning "Default Profile", so the default shows the canonical short URL.
  const slug = slugifyProfileLabel(profile.label);
  const profileUrl = profile.isDefault || !slug ? endpoint : `${endpoint}/${slug}`;
  const claudeCmd = `claude mcp add --transport http fgac ${profileUrl}`;

  return (
    <Card>
      <CardHeader
        title="Connect a new agent via MCP"
        subtitle={
          profile.isDefault
            ? 'Agents that connect through this URL attach to your Default Profile read-only; re-scope or block them above.'
            : `Agents that connect through this URL attach to “${profile.label}” automatically — no dashboard step needed.`
        }
      />
      <div className="px-5 pb-5 space-y-3">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            MCP endpoint for this profile
          </p>
          <CopyRow value={profileUrl} />
        </div>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Claude Code — run in your project directory
          </p>
          <CopyRow value={claudeCmd} />
        </div>
        {/* Endpoint and key sit together because configuring an agent needs
            both; splitting them across cards made people hunt for the key. */}
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            Bearer token for this profile
          </p>
          <SecretKeyDisplay apiKey={profile.key} className="text-[12px] text-foreground w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-0.5">
          <DirectoryCta
            location="dashboard_connect"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-claude-border bg-claude-bg px-3 py-1 text-[12px] font-semibold text-claude hover:opacity-80"
          >
            <span className="h-[7px] w-[7px] rounded-full bg-claude" />
            Connect in Claude.ai Directory
          </DirectoryCta>
          <span className="text-[11px] text-subtle">No endpoint or token needed.</span>
        </div>
      </div>
    </Card>
  );
}
