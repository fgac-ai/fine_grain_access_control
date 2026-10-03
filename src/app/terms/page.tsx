import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service | FGAC.ai',
  description: 'The terms that govern your use of FGAC.ai.',
};

/* Fixed on purpose — bump when the text changes (see privacy/page.tsx). */
const EFFECTIVE_DATE = 'October 3, 2026';

export default function TermsOfService() {
  return (
    <div className="px-4 py-12 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl rounded-2xl border border-border bg-card p-6 text-card-foreground sm:p-10">
        <h1 className="mb-2 text-3xl font-extrabold tracking-tight text-foreground">Terms of Service</h1>
        <p className="mb-8 text-sm text-muted-foreground">Effective date: {EFFECTIVE_DATE}</p>

        <div className="space-y-8 leading-relaxed">
          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">1. Acceptance of Terms</h2>
            <p>
              By accessing and using FGAC.ai (&ldquo;the Service&rdquo;), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">2. Description of Service</h2>
            <p>
              FGAC.ai is a permissions layer that sits between the AI agents you configure and Google services &mdash; Gmail, Google Drive, Google Sheets, Google Docs and Google Slides &mdash; through FGAC&rsquo;s MCP server and REST proxy. We provide a platform for you to connect agents, generate proxy API keys and define access rules (allowlists, blocklists, and per-file or per-folder permissions) that restrict the actions your AI agents can perform on your behalf.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">3. Use of Google Services</h2>
            <p>
              The Service requires you to authenticate with your Google account. Your use of the Service to interact with Google APIs is subject to the <Link href="/privacy" className="text-primary underline underline-offset-2">FGAC.ai Privacy Policy</Link> and the Google API Services User Data Policy. You maintain full ownership of your data, and we do not claim any rights over the email, file or document content processed through the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">4. User Account and Security</h2>
            <p>
              You are responsible for maintaining the confidentiality of any proxy API keys you generate and for the agents you connect. You agree to immediately revoke any keys or connections, or notify us, on any unauthorized use of your account. We are not liable for any loss or damage arising from your failure to protect your API keys.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">5. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>Violate any local, state, national, or international law.</li>
              <li>Attempt to bypass, disable, or interfere with security-related features of the Service.</li>
              <li>Use the Service for sending spam, phishing, or bulk unsolicited emails.</li>
              <li>Access a mailbox or file that its owner has not delegated or shared to you through the Service.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">6. Disclaimer of Warranties and Limitation of Liability</h2>
            <p className="mb-2 font-bold text-destructive">
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTY OF ANY KIND.
            </p>
            <p>
              FGAC.ai strictly disclaims all warranties, express or implied. Under no circumstances, including negligence, shall FGAC.ai or its developers be liable for any direct, indirect, incidental, special, punitive, or consequential damages (including, but not limited to, data loss, unauthorized AI agent actions, loss or alteration of emails or files, or API quota overages) arising out of or in connection with the use of the Service. You acknowledge that controlling AI agents is inherently unpredictable and you assume all risk associated with granting them access to your accounts through the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">7. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless FGAC.ai, its authors, and affiliates from and against any and all claims, damages, obligations, losses, liabilities, costs, or debt, and expenses (including but not limited to attorney&rsquo;s fees) arising from: (i) your use of and access to the Service; (ii) your violation of any term of these Terms of Service; (iii) any actions taken by AI agents utilizing your generated proxy keys or connections; or (iv) your violation of any third-party right, including without limitation any copyright, property, or privacy right.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">8. Changes to Terms</h2>
            <p>
              We reserve the right to modify these terms at any time. We will provide notice of significant changes by updating the effective date at the top of this page. Your continued use of the Service after such changes constitutes your acceptance of the new Terms of Service.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-bold text-foreground">9. Contact</h2>
            <p>
              Questions about these terms or the Service can be sent to{' '}
              <a href="mailto:support@fgac.ai" className="text-primary underline underline-offset-2">support@fgac.ai</a>.
            </p>
          </section>
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
