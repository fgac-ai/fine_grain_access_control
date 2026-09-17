"use client";

import { useState, useEffect, useCallback } from 'react';
import { useGooglePicker, PickedFile } from './useGooglePicker';
import { DRIVE_FILE_KINDS, type DriveFileKind } from '@/lib/driveFileKinds';

interface FileRule {
  id: string;
  ruleName: string;
  targetResourceId: string;
  resourceName: string | null;
  actionType: string;
  assignedKeyIds: string[];
}

interface ProxyKeyInfo {
  id: string;
  label: string;
}

const KIND_UI = {
  sheet: {
    title: 'Google Sheets Access Rules',
    subject: 'Google Sheets',
    addLabel: 'Add Google Sheet +',
    idHeader: 'Spreadsheet ID',
    emptyTitle: 'No Google Sheets exposed yet',
    emptyBody: 'Click "Add Google Sheet +" to pick spreadsheets using Google Picker and define Read or Read/Write permissions.',
    accent: 'emerald',
    iconPath: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
    grantPath: '/api/rules/grant-sheets-access',
    verifyPath: '/api/rules/verify-sheets-access',
    rulesKey: 'sheetsRules',
    noun: 'sheet',
  },
  doc: {
    title: 'Google Docs Access Rules',
    subject: 'Google Docs',
    addLabel: 'Add Google Doc +',
    idHeader: 'Document ID',
    emptyTitle: 'No Google Docs exposed yet',
    emptyBody: 'Click "Add Google Doc +" to pick documents using Google Picker and define Read or Read/Write permissions.',
    accent: 'blue',
    iconPath: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    grantPath: '/api/rules/grant-docs-access',
    verifyPath: '/api/rules/verify-docs-access',
    rulesKey: 'docsRules',
    noun: 'doc',
  },
  slide: {
    title: 'Google Slides Access Rules',
    subject: 'Google Slides',
    addLabel: 'Add Google Slides +',
    idHeader: 'Presentation ID',
    emptyTitle: 'No Google Slides exposed yet',
    emptyBody: 'Click "Add Google Slides +" to pick presentations using Google Picker and define Read or Read/Write permissions.',
    accent: 'amber',
    iconPath: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 13H6V8h12v8zm-9-6h6v4H9v-4z',
    grantPath: '/api/rules/grant-slides-access',
    verifyPath: '/api/rules/verify-slides-access',
    rulesKey: 'slidesRules',
    noun: 'presentation',
  },
} as const;

export function ExposedFilesManager({ kind, activeKeys = [] }: { kind: DriveFileKind; activeKeys?: ProxyKeyInfo[] }) {
  void activeKeys;
  const ui = KIND_UI[kind];
  const d = DRIVE_FILE_KINDS[kind];
  const [fileRules, setFileRules] = useState<FileRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // fileId → Google-side grant state ('ok' | 'missing' | 'unknown').
  // A rule can exist without Google ever having shared the file (approved
  // via magic link, never picked) — those rows get a "Needs Google access"
  // chip. Verification failing entirely degrades to no chips, never a
  // broken card. `title` is the LIVE Drive filename from the same call —
  // rendered ahead of the stored (grant-time) resourceName.
  const [grantStates, setGrantStates] = useState<Record<string, { state: string; title?: string | null }>>({});

  const fetchFileRules = useCallback(async () => {
    try {
      const res = await fetch(ui.grantPath);
      const data = await res.json();
      if (data[ui.rulesKey]) {
        setFileRules(data[ui.rulesKey]);
      }
    } catch (err) {
      console.error(`Failed to load ${ui.noun} rules:`, err);
    } finally {
      setIsLoading(false);
    }
    try {
      const res = await fetch(ui.verifyPath);
      const data = await res.json();
      setGrantStates(data.grants ?? {});
    } catch {
      setGrantStates({});
    }
  }, [ui.grantPath, ui.verifyPath, ui.rulesKey, ui.noun]);

  useEffect(() => {
    fetchFileRules();
  }, [fetchFileRules]);

  const handleFilesPicked = async (picked: PickedFile[]) => {
    setStatusMessage(`Saving exposed ${ui.noun}s to FGAC...`);
    for (const file of picked) {
      await fetch(ui.grantPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetResourceId: file.id,
          resourceName: file.name,
          actionType: d.actionTypes.read, // Default to Read Only
        })
      });
    }
    await fetchFileRules();
    setStatusMessage(`Successfully added ${picked.length} ${ui.noun}(s)!`);
    setTimeout(() => setStatusMessage(null), 4000);
  };

  const { triggerAddSheets: triggerAddFiles, isLoading: isPickerLoading } = useGooglePicker(handleFilesPicked, kind);

  const handlePermissionChange = async (targetResourceId: string, resourceName: string | null, newActionType: string) => {
    try {
      await fetch(ui.grantPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetResourceId,
          resourceName: resourceName || `${d.noun.charAt(0).toUpperCase() + d.noun.slice(1)} (${targetResourceId.slice(0, 6)})`,
          actionType: newActionType
        })
      });
      await fetchFileRules();
    } catch (err) {
      console.error('Failed to update permission:', err);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await fetch(`${ui.grantPath}?ruleId=${ruleId}`, {
        method: 'DELETE'
      });
      await fetchFileRules();
    } catch (err) {
      console.error(`Failed to remove ${ui.noun} rule:`, err);
    }
  };

  const accentText = ui.accent === 'emerald' ? 'text-emerald-600' : ui.accent === 'amber' ? 'text-amber-600' : 'text-blue-600';
  const accentButton = ui.accent === 'emerald'
    ? 'bg-emerald-600 hover:bg-emerald-500'
    : ui.accent === 'amber'
      ? 'bg-amber-600 hover:bg-amber-500'
      : 'bg-blue-600 hover:bg-blue-500';
  const accentStatus = ui.accent === 'emerald'
    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
    : ui.accent === 'amber'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-blue-50 border-blue-200 text-blue-800';
  const accentDot = ui.accent === 'emerald' ? 'bg-emerald-500' : ui.accent === 'amber' ? 'bg-amber-500' : 'bg-blue-500';

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <svg className={`w-6 h-6 ${accentText}`} viewBox="0 0 24 24" fill="currentColor">
              <path d={ui.iconPath} />
            </svg>
            <h3 className="text-lg font-bold text-slate-900">{ui.title}</h3>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Grant agents intentional access to specific {ui.subject} via per-file (<code className="bg-slate-100 px-1 py-0.5 rounded text-slate-800 text-xs">drive.file</code>) permission.
          </p>
        </div>
        <button
          onClick={() => triggerAddFiles()}
          disabled={isPickerLoading}
          className={`flex items-center justify-center gap-2 ${accentButton} text-white font-medium text-sm px-4 py-2 rounded-lg transition-colors shadow-sm disabled:opacity-50 flex-shrink-0`}
        >
          {isPickerLoading ? (
            <span>Connecting...</span>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              <span>{ui.addLabel}</span>
            </>
          )}
        </button>
      </div>

      {statusMessage && (
        <div className={`mb-4 p-3 border text-sm rounded-lg flex items-center gap-2 ${accentStatus}`}>
          <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${accentDot}`} />
          {statusMessage}
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-slate-400 text-sm">Loading {ui.noun}s access rules...</div>
      ) : fileRules.length === 0 ? (
        <div className="py-8 border-2 border-dashed border-slate-200 rounded-lg text-center p-6 bg-slate-50/50">
          <svg className="w-10 h-10 text-slate-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-sm font-medium text-slate-700">{ui.emptyTitle}</p>
          <p className="text-xs text-slate-500 mt-1 mb-3">
            {ui.emptyBody}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 font-semibold text-xs uppercase tracking-wider bg-slate-50">
                <th className="py-3 px-4">Document Title</th>
                <th className="py-3 px-4">{ui.idHeader}</th>
                <th className="py-3 px-4">FGAC Permission</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fileRules.map((rule) => {
                const displayName =
                  grantStates[rule.targetResourceId]?.title || rule.resourceName || rule.ruleName;
                return (
                <tr key={rule.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3 px-4 font-medium text-slate-900 flex items-center gap-2">
                    <svg className={`w-4 h-4 ${accentText} flex-shrink-0`} fill="currentColor" viewBox="0 0 24 24">
                      <path d={ui.iconPath} />
                    </svg>
                    <span>{displayName}</span>
                    {grantStates[rule.targetResourceId]?.state === 'missing' && (
                      <a
                        href={`${d.setupPath}?${d.setupIdParam}=${encodeURIComponent(rule.targetResourceId)}${displayName !== rule.ruleName ? `&name=${encodeURIComponent(displayName)}` : ''}`}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 transition-colors flex-shrink-0"
                        title={`FGAC has this rule, but Google hasn't shared the ${ui.noun} with FGAC yet — agents get errors until you pick it in the Google Picker.`}
                      >
                        ⚠ Needs Google access — finish setup
                      </a>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-600">
                    {rule.targetResourceId ? (
                      <span className="bg-slate-100 px-2 py-1 rounded border border-slate-200" title={rule.targetResourceId}>
                        {rule.targetResourceId.length > 16 ? `${rule.targetResourceId.slice(0, 12)}...` : rule.targetResourceId}
                      </span>
                    ) : (
                      <span className="text-slate-400">N/A</span>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <select
                      value={rule.actionType}
                      onChange={(e) => handlePermissionChange(rule.targetResourceId, rule.resourceName, e.target.value)}
                      className={`text-xs font-semibold px-2.5 py-1.5 rounded-md border focus:outline-none focus:ring-2 ${
                        rule.actionType === d.actionTypes.read
                          ? 'bg-blue-50 text-blue-700 border-blue-200 focus:ring-blue-500'
                          : rule.actionType === d.actionTypes.readWrite
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 focus:ring-emerald-500'
                          : 'bg-rose-50 text-rose-700 border-rose-200 focus:ring-rose-500'
                      }`}
                    >
                      <option value={d.actionTypes.read}>Read Only (GET)</option>
                      <option value={d.actionTypes.readWrite}>Read & Write (GET + POST/PUT)</option>
                      <option value={d.actionTypes.block}>Blocked (Deny All)</option>
                    </select>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="text-xs text-rose-600 hover:text-rose-800 font-medium px-2 py-1 hover:bg-rose-50 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
