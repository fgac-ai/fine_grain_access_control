import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Privacy Policy | FGAC.ai',
  description:
    'How FGAC.ai collects, uses, stores and protects your information, including the Gmail and Google Drive data your AI agents reach through FGAC.',
};

/* ─── Privacy Policy ─────────────────────────────────────────────────────────
   Every factual statement on this page is checked against the code in
   docs/implementation_plans/claude_privacy-policy-google-verification_v1.md
   (claim → file table). When behaviour changes, change the text AND bump the
   effective date below. The date is a fixed string on purpose: a page that
   stamps today's date on every render reads as a template to a reviewer. */

const EFFECTIVE_DATE = 'October 3, 2026';

const LIMITED_USE_URL =
  'https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes';
const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';
const SUPPORT_EMAIL = 'support@fgac.ai';

const SECTIONS = [
  { id: 'introduction', title: '1. Introduction' },
  { id: 'google-limited-use', title: '2. Google API Services User Data Policy' },
  { id: 'information-we-collect', title: '3. Information we collect' },
  { id: 'how-we-use', title: '4. How we use information' },
  { id: 'ai-agents', title: '5. AI agents and MCP clients you connect' },
  { id: 'delegated-access', title: '6. Delegated access to another person’s mailbox' },
  { id: 'service-emails', title: '7. Emails FGAC sends you' },
  { id: 'sharing', title: '8. Sharing and service providers' },
  { id: 'security', title: '9. Security' },
  { id: 'retention', title: '10. Retention and deletion' },
  { id: 'your-rights', title: '11. Your rights and choices' },
  { id: 'children', title: '12. Children' },
  { id: 'changes', title: '13. Changes to this policy' },
  { id: 'contact', title: '14. Contact' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const title = SECTIONS.find(s => s.id === id)!.title;
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mb-3 text-xl font-bold text-foreground">{title}</h2>
      <div className="space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="pt-2 text-base font-semibold text-foreground">{children}</h3>;
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">
      {children}
    </a>
  );
}

function Mail() {
  return <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary underline underline-offset-2 hover:opacity-80">{SUPPORT_EMAIL}</a>;
}

/* A table that stacks into labelled blocks below `sm`, so four columns stay
   readable at phone width without a horizontal scroll. */
function StackedTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="hidden sm:table-header-group">
        <tr className="border-b border-border text-left">
          {headers.map(h => (
            <th key={h} scope="col" className="py-2 pr-4 align-bottom text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="block border-b border-border py-3 sm:table-row sm:py-0">
            {cells.map((cell, j) => (
              <td key={j} className="block py-1 align-top sm:table-cell sm:py-3 sm:pr-4">
                <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:hidden">{headers[j]}</span>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PrivacyPolicy() {
  return (
    <div className="px-4 py-12 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl rounded-2xl border border-border bg-card p-6 text-card-foreground sm:p-10">
        <h1 className="mb-2 text-3xl font-extrabold tracking-tight text-foreground">Privacy Policy</h1>
        <p className="mb-8 text-sm text-muted-foreground">Effective date: {EFFECTIVE_DATE}</p>

        <nav aria-label="Contents" className="mb-10 rounded-xl border border-border bg-background p-4 sm:p-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contents</p>
          <ol className="columns-1 gap-x-8 space-y-1 text-sm sm:columns-2">
            {SECTIONS.map(s => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-primary hover:underline">{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-10">
          <Section id="introduction">
            <p>
              FGAC.ai (&ldquo;FGAC&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a permissions layer between the AI agents you choose and
              your Google account. You connect your Google account to FGAC once, create agent profiles with the rules you want, and
              point your agents at FGAC instead of at Google. Every call an agent makes passes through FGAC&rsquo;s MCP server or REST
              proxy, where FGAC checks it against your rules before anything reaches Google, and relays only what the rules allow
              back to the agent.
            </p>
            <p>
              This policy explains what information FGAC collects, how we use, share and protect it, how long we keep it, and the
              choices you have. It covers the website at fgac.ai, the FGAC dashboard, the FGAC MCP server and REST proxy, and the
              emails FGAC sends. It does not cover the AI agents, assistants or other services you connect to FGAC (see Section 5) or
              Google&rsquo;s own services, each of which has its own privacy policy.
            </p>
          </Section>

          <Section id="google-limited-use">
            <div className="rounded-xl border border-primary/30 bg-primary-muted p-5">
              <p className="font-medium text-foreground">
                FGAC.ai&rsquo;s use and transfer to any other app of information received from Google APIs will adhere to the{' '}
                <Ext href={LIMITED_USE_URL}>Google API Services User Data Policy</Ext>, including the Limited Use requirements.
              </p>
            </div>
            <p>In plain terms, for information FGAC receives from Google APIs, we:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">Use it only to provide and improve the user-facing features described in this policy</strong>:
                relaying it to the agents you connect, enforcing the rules you set, and showing you what you have configured.
              </li>
              <li><strong className="text-foreground">Do not use it for advertising</strong>, and never sell it.</li>
              <li>
                <strong className="text-foreground">Do not transfer it to anyone</strong> except the agent you connected, the service
                providers in Section 8 that process it on our behalf, as required by law, or as needed to investigate abuse and protect
                the security of the service.
              </li>
              <li>
                <strong className="text-foreground">Do not let any person read it</strong>, except when you ask us to (for example, to
                investigate a support request you raise), when it is necessary for security purposes such as investigating abuse,
                when the law requires it, or when it has been aggregated and de-identified for internal operations.
              </li>
              <li>
                <strong className="text-foreground">Do not use it to develop, improve or train generalized artificial-intelligence or
                machine-learning models.</strong> FGAC itself runs no AI models over your data. The only AI involved is the agent you
                choose to connect (Section 5).
              </li>
            </ul>
          </Section>

          <Section id="information-we-collect">
            <H3>3.1 Account information</H3>
            <p>
              When you sign in with Google, our authentication provider, Clerk, receives your Google basic profile: your name, email
              address and profile picture. FGAC&rsquo;s own database stores your email address and the identifiers that tie your FGAC
              account to Clerk. Clerk stores the profile and the Google OAuth tokens (access and refresh tokens) that FGAC uses to call
              Google on your behalf. FGAC&rsquo;s database never stores your Google tokens.
            </p>

            <H3>3.2 Google user data, permission by permission</H3>
            <p>
              FGAC asks Google for the permissions below. The first three are requested when you sign in. The full Google Drive
              permission is requested only if you opt in, and only from accounts enrolled in the Drive folder-permissions beta.
            </p>
            <StackedTable
              headers={['Permission', 'What it lets FGAC reach', 'How FGAC uses it', 'What FGAC keeps']}
              rows={[
                [
                  <span key="p"><strong className="text-foreground">Basic profile</strong><br /><code className="text-xs">openid</code>, <code className="text-xs">email</code>, <code className="text-xs">profile</code></span>,
                  <span key="a">Your name, email address and profile picture.</span>,
                  <span key="u">To create and identify your FGAC account, show it to you, and contact you about the service.</span>,
                  <span key="k">Your email address and account identifiers, for as long as you have an account. Clerk holds the name and picture.</span>,
                ],
                [
                  <span key="p"><strong className="text-foreground">Gmail</strong><br /><code className="text-xs">gmail.modify</code></span>,
                  <span key="a">
                    Reading, searching, labelling, archiving and trashing the messages, drafts and attachments in your mailbox, and
                    sending email from it. FGAC never permanently deletes mail: delete and batch-delete requests are refused whatever
                    your rules say, and trashing is reversible.
                  </span>,
                  <span key="u">
                    Only when an agent you connected makes a call. FGAC fetches what the agent asked for with your Google token,
                    applies your rules in memory (for example, hide messages matching a pattern, or allow sending only to recipients
                    you approved) and returns the allowed result to that agent. The dashboard also reads your label names, live, to
                    populate the rule editor.
                  </span>,
                  <span key="k">
                    Nothing from your mail: no message bodies, subjects, senders, recipients or attachments. FGAC keeps the rules you
                    create (which may name a label or a recipient address) and the request metadata in Section 3.4.
                  </span>,
                ],
                [
                  <span key="p"><strong className="text-foreground">Google Drive, per file</strong><br /><code className="text-xs">drive.file</code></span>,
                  <span key="a">
                    Only the files you pick in the Google Picker and the files your agent creates or copies through FGAC: Google
                    Sheets, Docs, Slides and other Drive files. FGAC can read, edit, comment on and copy those files and create new
                    ones. It cannot see the rest of your Drive.
                  </span>,
                  <span key="u">
                    To relay reads and edits to your agent under the per-file setting you chose (Read, Read &amp; write, or Blocked),
                    and to show the file&rsquo;s name on the dashboard and on approval pages.
                  </span>,
                  <span key="k">The file&rsquo;s id and title and the setting you chose. Never its contents.</span>,
                ],
                [
                  <span key="p"><strong className="text-foreground">Google Drive, full</strong> (opt-in beta)<br /><code className="text-xs">drive</code></span>,
                  <span key="a">
                    All of your Google Drive files, including shared drives and files shared with you (Google describes this
                    permission as &ldquo;See, edit, create, and delete all of your Google Drive files&rdquo;). FGAC asks for it only when
                    you click <em>Enable full Drive access</em> on an agent profile, a control shown only to beta accounts. Agents still
                    cannot permanently delete anything through FGAC.
                  </span>,
                  <span key="u">
                    To list your folders and files so the dashboard can show your Drive as a tree and let you search it; to read a
                    file&rsquo;s metadata (id, name, type, parent folders, shared drive, whether you own it) so FGAC can work out which
                    folder setting applies when your agent reaches a file; to filter the file listings your agent requests down to
                    what your settings allow; and to relay allowed reads and edits to your agent.
                  </span>,
                  <span key="k">
                    The ids and names of the folders and files you set a permission on. File metadata is cached in server memory for
                    up to 10 minutes while FGAC resolves folder settings, then discarded. File contents are never stored.
                  </span>,
                ],
              ]}
            />

            <H3>3.3 Configuration you create</H3>
            <p>
              Your agent profiles and proxy keys (a label, the key itself, an optional expiry, and the profile&rsquo;s Drive default);
              your access rules (a name, a type, a pattern that may contain email addresses or Gmail label ids, and the id and title
              of a target file or folder); delegations you grant or receive (which FGAC user may reach whose mailbox); the agent
              connections you approve (the connecting client&rsquo;s id and name, such as &ldquo;claude-desktop&rdquo;, and any nickname you
              give it); and the approvals you grant through approval links.
            </p>

            <H3>3.4 Usage and technical data</H3>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">Request metadata.</strong> For every call an agent makes through FGAC we record
                which tool or endpoint was called, when, how long it took, whether it was allowed, denied or failed and why, the
                mailbox address the call used (and any mailbox address the agent asked for that the key could not use), the ids
                and types of files involved, the agent&rsquo;s client name and user-agent, and any error code or message Google
                returned. We never record message bodies, subjects, attachments or file contents.
              </li>
              <li>
                <strong className="text-foreground">Ledgers in our database.</strong> Approval requests (the action, the recipient
                address or file involved, the file&rsquo;s title when the agent supplied one, and when the request was created,
                opened and approved); mailbox addresses an agent named that its key could not use; Google grants that stopped
                working (the mailbox, the reason and when); which notice emails we sent; and notices that bounced (the address
                and the bounce code).
              </li>
              <li>
                <strong className="text-foreground">Website analytics.</strong> We use PostHog to record page views, clicks, feature
                usage and errors on fgac.ai, together with your browser and device type, IP address and the approximate location
                derived from it. Once you are signed in these events are tied to your FGAC account (Clerk id, email address and
                name). Error reports contain the error&rsquo;s type, message and stack trace, never your Google data. PostHog also
                evaluates feature flags (such as the Drive beta) using your Clerk id and email address.
              </li>
              <li>
                <strong className="text-foreground">Session replay.</strong> PostHog records how you interact with fgac.ai pages: mouse
                movement, clicks, scrolling, the page structure and browser console messages. Text you type into form fields is
                masked in your browser before anything is sent. What the dashboard shows you (rule names, file titles, mailbox
                addresses, label names) can appear in a replay; your Gmail and Drive contents cannot, because FGAC&rsquo;s website never
                displays them. Replays are kept for 30 days.
              </li>
              <li>
                <strong className="text-foreground">Server logs.</strong> Our hosting provider, Vercel, keeps request metadata and
                error messages for a short rolling window for operations and debugging.
              </li>
            </ul>

            <H3>3.5 Cookies and similar technologies</H3>
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">Clerk sign-in cookies</strong> (<code className="text-xs">__session</code>, <code className="text-xs">__client_uat</code> and related) keep you signed in. They are strictly necessary.</li>
              <li><code className="text-xs">fgac_last_account</code> and <code className="text-xs">fgac_prev_account</code> (7 days) remember which FGAC account was last signed in on this browser, as a Clerk id only, so that a second account you create can be offered a one-click delegation to the first.</li>
              <li><code className="text-xs">fgac_approval_wall</code> (30 minutes) remembers which approval link you were sent to before signing in, so FGAC can send you back to it afterwards.</li>
              <li><code className="text-xs">fgac_clerk_bounce</code> (5 minutes) detects sign-in redirect loops.</li>
              <li><strong className="text-foreground">PostHog</strong> (<code className="text-xs">ph_…</code> cookie and local storage) holds the analytics identifier and session described in Section 3.4.</li>
              <li>The <strong className="text-foreground">Google Picker</strong> is Google&rsquo;s own component, loaded in your browser when you choose files; Google&rsquo;s cookies and privacy policy apply to it.</li>
            </ul>
            <p>FGAC uses no advertising cookies and no third-party advertising technology.</p>

            <H3>3.6 Information you give us directly</H3>
            <p>
              If you use the contact-sales form on the pricing page, we receive the email address, company, team size and needs you
              enter; FGAC emails you a confirmation with a copy to our sales inbox and records the lead in PostHog. If you email us,
              we keep the correspondence to answer you.
            </p>
          </Section>

          <Section id="how-we-use">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">To provide the service</strong>: authenticate you, relay the calls your agents make to Google, enforce your rules, and show you your profiles, rules, approvals and connections.</li>
              <li><strong className="text-foreground">To keep you informed</strong>: the service emails in Section 7, and answers to your support requests.</li>
              <li><strong className="text-foreground">To keep the service secure</strong>: refuse agents presenting revoked keys, detect abuse and automated scanning, verify webhooks, and investigate incidents.</li>
              <li><strong className="text-foreground">To understand and improve the product</strong>: analytics and error tracking in Section 3.4, feature flags for betas such as Drive folder permissions.</li>
              <li><strong className="text-foreground">To comply with law</strong> and enforce our <Link href="/terms" className="text-primary underline underline-offset-2">Terms of Service</Link>.</li>
            </ul>
            <p>
              Where the GDPR or UK GDPR applies, our legal bases are: performance of our contract with you (providing the service),
              our legitimate interests (security, analytics and product improvement), your consent (the optional full Google Drive
              permission, which you can withdraw at any time), and compliance with legal obligations.
            </p>
          </Section>

          <Section id="ai-agents">
            <p>
              FGAC exists to hand your Google data to the agent you chose, within the rules you set. Agents connect in two ways:
              through an OAuth connection, where an MCP-compatible client (for example Claude.ai, Claude Code, the Claude desktop app,
              ChatGPT, Cursor, Grok, or any other MCP client) signs in to FGAC and is attached to your Default Profile so it can start
              immediately; or through a proxy key you create on an agent profile and paste into the agent&rsquo;s configuration.
            </p>
            <p>
              On every call, FGAC fetches the data from Google with your Google grant, applies the rules of the profile the agent is
              attached to, and returns the allowed result to that agent. From that point the data is in the agent&rsquo;s hands: it may
              appear in your conversation, be stored in the agent&rsquo;s history, or be processed by the agent&rsquo;s provider. What the
              provider does with it is governed by that provider&rsquo;s terms and privacy policy, not by this one, and FGAC has no
              control over it.
            </p>
            <p>
              You decide which agents to connect. In the dashboard you can move a connection to a profile with narrower rules, block
              it, revoke a proxy key, or remove a connection; the agent is refused from that moment. FGAC does not run AI models over
              your data and is not itself an agent.
            </p>
          </Section>

          <Section id="delegated-access">
            <p>
              FGAC lets one FGAC user (the owner) delegate their mailbox to another FGAC user (the delegate), so that the
              delegate&rsquo;s agents can reach the owner&rsquo;s Gmail under the rules the delegate configures.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">If you are the owner</strong>, your Google grant stays with your account and is used
                for the delegate&rsquo;s calls; the delegate never receives your Google token. Those calls are recorded as request
                metadata (Section 3.4) under both accounts. You can revoke a delegation at any time from the Accounts page, and access
                stops immediately. If your Google grant stops working while a delegation is active, FGAC may email you once about it
                and copy the delegate (Section 7).
              </li>
              <li>
                <strong className="text-foreground">If you are the delegate</strong>, everything in this policy about Gmail data applies
                equally to the owner&rsquo;s data your agents reach, and you must use that access only as the owner intended.
              </li>
            </ul>
          </Section>

          <Section id="service-emails">
            <p>
              FGAC sends a small number of transactional emails from its own support mailbox. They are sent through FGAC&rsquo;s own
              Google account, never through yours:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>an approval link, when an agent asks again for a permission you have not yet acted on;</li>
              <li>a notice that your Google connection stopped working or lacks a permission an agent needs, with a reconnect link (copied to the delegate when the mailbox is delegated);</li>
              <li>a notice that an agent keeps naming a mailbox its key cannot use, so you can fix the agent&rsquo;s configuration;</li>
              <li>a confirmation of a contact-sales submission.</li>
            </ul>
            <p>
              Each is sent once per event, never more than three per person per day, and the connection notices are additionally
              capped across all users so that a provider outage cannot trigger a flood. Notices that bounce are recorded so we stop
              writing to an address that no longer exists. These are the only automated emails FGAC sends; we do not send marketing
              email.
            </p>
          </Section>

          <Section id="sharing">
            <p>We do not sell personal information and do not share it for advertising. We share information only as follows.</p>
            <p><strong className="text-foreground">Service providers (sub-processors)</strong> that process data on our behalf under their own data-processing terms:</p>
            <StackedTable
              headers={['Provider', 'Role', 'What it receives']}
              rows={[
                [<span key="p"><strong className="text-foreground">Google</strong></span>, <span key="r">Gmail, Drive, Sheets, Docs and Slides APIs; sign-in; the Google Picker.</span>, <span key="w">The calls FGAC makes with your grant, and the files you pick.</span>],
                [<span key="p"><strong className="text-foreground">Clerk</strong></span>, <span key="r">Authentication, storage of your Google OAuth tokens, and the OAuth server that MCP clients connect through.</span>, <span key="w">Your profile, Google tokens, sessions, and the registrations of the clients you connect.</span>],
                [<span key="p"><strong className="text-foreground">Neon</strong></span>, <span key="r">PostgreSQL database hosting.</span>, <span key="w">The account, configuration and ledger data in Sections 3.1, 3.3 and 3.4.</span>],
                [<span key="p"><strong className="text-foreground">Vercel</strong></span>, <span key="r">Application hosting, edge network and runtime logs.</span>, <span key="w">All traffic to fgac.ai, including agent calls in transit, and the server logs in Section 3.4.</span>],
                [<span key="p"><strong className="text-foreground">PostHog</strong></span>, <span key="r">Product analytics, error tracking, session replay and feature flags.</span>, <span key="w">The analytics, error and replay data in Section 3.4.</span>],
              ]}
            />
            <p><strong className="text-foreground">Others, at your direction or as required:</strong></p>
            <ul className="list-disc space-y-2 pl-5">
              <li>the AI agents and MCP clients you connect (Section 5) and the people you delegate to (Section 6);</li>
              <li>a partner application, if you connected FGAC through that partner&rsquo;s own &ldquo;connect&rdquo; flow: FGAC may send it notifications containing only Gmail message ids, never content, so the partner can fetch the message through FGAC under your rules;</li>
              <li>law enforcement or other parties when required by law, or to protect the rights, safety and security of FGAC, its users or the public;</li>
              <li>a successor, if FGAC is involved in a merger, acquisition or sale of assets, in which case this policy continues to apply and you will be notified.</li>
            </ul>
            <p>Our service providers host data in the United States. If you use FGAC from elsewhere, your information is transferred to and processed there.</p>
          </Section>

          <Section id="security">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong className="text-foreground">Encryption.</strong> All traffic to fgac.ai, to Google and to our providers travels over HTTPS (TLS). Our database, authentication and analytics providers encrypt stored data at rest.</li>
              <li><strong className="text-foreground">Token custody.</strong> Your Google tokens are held by Clerk and used server-side. They are never written to FGAC&rsquo;s database, and they are never given to an agent; agents hold only an FGAC proxy key or an FGAC OAuth token that FGAC can revoke. The one place a token leaves our servers is your own browser, to open the Google Picker.</li>
              <li><strong className="text-foreground">Least privilege by default.</strong> Google Drive access is per file unless you opt in to the full Drive permission; sending email is denied until you approve a recipient; a new proxy key reaches only the mailboxes you attach to it; permanent deletion is refused everywhere.</li>
              <li><strong className="text-foreground">Nothing stored that need not be.</strong> Gmail and Drive contents are processed in memory and discarded when the call completes.</li>
              <li><strong className="text-foreground">Access controls.</strong> Every dashboard action requires your Clerk session; approval links are signed and only work for the signed-in owner; incoming webhooks are signature-verified; access to production systems is limited to the people who operate FGAC.</li>
              <li>No system is perfectly secure. If we learn of a breach affecting your data, we will notify you as the law requires.</li>
            </ul>
          </Section>

          <Section id="retention">
            <StackedTable
              headers={['Data', 'How long FGAC keeps it']}
              rows={[
                [<span key="d">Gmail and Google Drive contents</span>, <span key="h">Not stored. Held in memory only while a call is in flight.</span>],
                [<span key="d">Drive file metadata (full-Drive beta)</span>, <span key="h">Up to 10 minutes in server memory, then discarded.</span>],
                [<span key="d">Google OAuth tokens</span>, <span key="h">Held by Clerk until you revoke FGAC&rsquo;s access in your Google Account, remove the Google connection from your FGAC account settings, or delete your FGAC account.</span>],
                [<span key="d">Account, profiles, keys, rules, delegations, connections</span>, <span key="h">While your account exists and until you delete them. Deleted rules are removed immediately. Revoked keys and delegations are kept as revoked records so that an agent presenting an old key is refused.</span>],
                [<span key="d">Approval, connection-failure, refusal and bounce ledgers</span>, <span key="h">While your account exists; they are what keep the service emails in Section 7 to one per event.</span>],
                [<span key="d">Analytics events (PostHog)</span>, <span key="h">Up to seven years, under PostHog&rsquo;s standard retention.</span>],
                [<span key="d">Session replays (PostHog)</span>, <span key="h">30 days.</span>],
                [<span key="d">Server logs (Vercel) and database restore history (Neon)</span>, <span key="h">A short rolling window of days.</span>],
              ]}
            />
            <H3>Deleting your account</H3>
            <p>
              When you delete your FGAC account, Clerk notifies FGAC and FGAC immediately revokes all of your proxy keys, revokes
              every delegation you granted or received, and removes the access those delegations provided; your Google tokens are
              deleted with the Clerk account. Our database keeps an inert record of the account (your email address and
              identifiers) together with its revoked keys, rules and ledgers, so that a later sign-up with the same address starts
              fresh and cannot inherit the old access, and for security audit. To have that record erased as well, email{' '}
              <Mail /> from the address on the account; we will erase or anonymise it within 30 days of verifying the request unless
              the law requires us to keep it.
            </p>
          </Section>

          <Section id="your-rights">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-foreground">Revoke Google access at any time</strong> from your Google Account at{' '}
                <Ext href={GOOGLE_PERMISSIONS_URL}>myaccount.google.com/permissions</Ext>. FGAC&rsquo;s token stops working
                immediately and every agent call on that mailbox is refused until you reconnect.
              </li>
              <li><strong className="text-foreground">Control your agents</strong> in the dashboard: narrow a profile&rsquo;s rules, block or remove a connection, revoke a key, revoke a delegation, or withdraw the full Drive permission by reconnecting with the per-file permission only.</li>
              <li><strong className="text-foreground">Delete your account</strong> from the account menu (Manage account &rarr; Security) or by emailing <Mail />.</li>
              <li><strong className="text-foreground">Limit analytics.</strong> Browser privacy tools that block analytics scripts do not affect the service.</li>
              <li>
                <strong className="text-foreground">Exercise your data-protection rights.</strong> Wherever you live, you can ask us to
                access, correct, export, restrict or delete the personal information we hold about you, or object to our processing
                of it. Residents of the EU, UK and similar jurisdictions have these rights under the GDPR and may lodge a complaint
                with their supervisory authority; California residents have the rights to know, delete and correct under the CCPA,
                and we do not sell or share personal information for cross-context behavioral advertising. We will not discriminate
                against you for exercising any right.
              </li>
            </ul>
            <p>
              To make a request, email <Mail /> from the address on your account. We verify requests against that address, respond
              within one month, and may ask for more information where a request is unclear.
            </p>
          </Section>

          <Section id="children">
            <p>
              FGAC is not directed to children under 13 (or under 16 where local law sets that age), and we do not knowingly
              collect personal information from them. If you believe a child has created an FGAC account, email <Mail /> and we
              will delete it.
            </p>
          </Section>

          <Section id="changes">
            <p>
              When we change this policy we update the effective date at the top of this page. If a change materially reduces your
              rights or expands what we collect or share, we will notify you by email or by a notice on fgac.ai before it takes
              effect. Earlier versions are available on request.
            </p>
          </Section>

          <Section id="contact">
            <p>
              Questions about this policy, requests about your data, and privacy complaints go to <Mail />. FGAC.ai operates from
              the United States.
            </p>
          </Section>
        </div>

        <div className="mt-12 border-t border-border pt-8">
          <Link href="/" className="font-medium text-primary hover:underline">
            &larr; Back to Home
          </Link>
        </div>
      </article>
    </div>
  );
}
