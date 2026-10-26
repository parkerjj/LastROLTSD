/**
 * Privacy Policy (/privacy).
 * English is the authoritative version.
 * Applicable law: EU GDPR (Regulation (EU) 2016/679) + Estonian Personal Data Protection Act (IKS).
 */

import { mountLegalPage, type LegalPageConfig } from "./legal-page";
import {
  EE_DATA_PROTECTION_URL,
  LEGAL_EMAIL,
  LEGAL_ENTITY_NAME,
  LEGAL_LEGAL_FORM,
  LEGAL_REGISTRY_CODE,
} from "./legal-constants";

const CONFIG: LegalPageConfig = {
  pageTitle: "Privacy Policy",
  pageSlug: "/privacy",
  subtitle: "GDPR-compliant — data controller: Yue Liu (sole trader, Estonia)",
  sections: [
    {
      heading: "1. Data Controller",
      body: `
        <p>The data controller responsible for processing your personal data is Yue Liu (${LEGAL_LEGAL_FORM}), Estonian Business Registry reg. code ${LEGAL_REGISTRY_CODE}. Applicable law: EU General Data Protection Regulation (GDPR — Regulation (EU) 2016/679) and Estonian Personal Data Protection Act (Isikuandmete kaitse seadus, IKS).</p>
      `,
    },
    {
      heading: "2. What Data We Collect",
      body: `
        <p><strong>2.1 Account Registration Data.</strong> Email address (login, verification, password reset, membership expiry reminders), display name (public profile, if you choose), and keyed HMAC-SHA-256 password verification material using a random per-account salt (passwords are never stored in plaintext).</p>
        <p><strong>2.2 Usage Data (automatic).</strong> Our analytics provider 51.la automatically collects: browser user agent, OS, device type, pages visited, navigation path, and anonymized IP address (anonymized within 24 hours). Custom events include: search keywords, item history views, map button clicks, command-copy actions, QQ group copy, monitor account count, sponsor/stripe outbound clicks.</p>
        <p><strong>2.3 Security and Anti-Abuse Data.</strong> When you register, log in, verify your email, request or change a password, authorize or bind KoreEngine, or post in the guestbook, we record your IP address, approximate location (city level) and network provider derived from it, your browser user agent, a random device identifier stored in your browser's local storage, and a hash of browser characteristics (browser fingerprint). We use this data only to prevent abuse and fraud, such as one person operating many accounts, and to resolve disputes about account or game-character ownership.</p>
        <p><strong>2.3 Payment Data.</strong> You are redirected to Stripe's checkout page. The Operator receives ONLY a payment confirmation, plan identifier, and activation timestamp. We do NOT receive or store your card number, CVC, or bank account number.</p>
        <p><strong>2.4 Alert Configuration Data.</strong> If you configure email alerts via the monitoring dashboard, we store the LTSD account(s) you wish to monitor, your alert preferences, and alert delivery logs.</p>
        <p><strong>2.5 User-Generated Content.</strong> Guestbook posts may be visible to the public. Configuration sharing hall entries are visible only to logged-in users after you choose to share and save them. You can withdraw a shared configuration from the hall; copies already saved by other users remain in their accounts.</p>
      `,
    },
    {
      heading: "3. Legal Basis for Processing (GDPR Article 6)",
      body: `
        <table class="legal-table">
          <thead><tr><th>Processing Activity</th><th>Lawful Basis</th></tr></thead>
          <tbody>
            <tr><td>Account registration, login, password reset</td><td>Contract performance (Art. 6(1)(b))</td></tr>
            <tr><td>VIP Membership activation and management</td><td>Contract performance (Art. 6(1)(b))</td></tr>
            <tr><td>Email alerts</td><td>Consent (Art. 6(1)(a)) — you opt in explicitly</td></tr>
            <tr><td>Website analytics (51.la)</td><td>Legitimate interest (Art. 6(1)(f)) — aggregated usage, not profiling</td></tr>
            <tr><td>Security, fraud prevention, abuse detection</td><td>Legitimate interest (Art. 6(1)(f))</td></tr>
            <tr><td>Guestbook / configuration hall hosting</td><td>Legitimate interest (Art. 6(1)(f)) — community operation</td></tr>
            <tr><td>Security and anti-abuse records (IP address, approximate location, device identifier, browser fingerprint)</td><td>Legitimate interest (Art. 6(1)(f)) — preventing abuse and resolving ownership disputes</td></tr>
          </tbody>
        </table>
      `,
    },
    {
      heading: "4. How We Use Your Data",
      body: `
        <p>Operate and improve the Service; authenticate users; manage VIP memberships; deliver email alerts; understand aggregate usage patterns; prevent abuse, fraud, and security incidents; comply with legal obligations.</p>
      `,
    },
    {
      heading: "5. Third-Party Processors",
      body: `
        <table class="legal-table">
          <thead><tr><th>Processor</th><th>Location</th><th>Purpose</th><th>Data Shared</th></tr></thead>
          <tbody>
            <tr><td><strong>Stripe Payments Europe, Ltd.</strong></td><td>Ireland (EU)</td><td>Payment processing</td><td>Plan ID, billing email, amount, timestamp. NO card numbers or CVC.</td></tr>
            <tr><td><strong>51.la (Analyse Network Co., Ltd.)</strong></td><td>China (CN)</td><td>Web analytics</td><td>Anonymized browser session data, custom events, IP (anonymized within 24h)</td></tr>
            <tr><td><strong>Transactional email service</strong></td><td>EU or US</td><td>Account verification, expiry alerts</td><td>Recipient email, email content. NO credentials.</td></tr>
          </tbody>
        </table>
        <p><strong>Non-EU transfers.</strong> The only non-EU processor is 51.la (China). The IP address transferred is anonymized within 24 hours and never linked to an identifiable individual. Non-EU mail delivery services are covered by Standard Contractual Clauses (SCCs) per EU Commission Decision 2021/914.</p>
      `,
    },
    {
      heading: "6. Data Retention",
      body: `
        <table class="legal-table">
          <thead><tr><th>Data Category</th><th>Retention Period</th></tr></thead>
          <tbody>
            <tr><td>Account data (email, display name)</td><td>Lifetime of account + 30 days after deletion</td></tr>
            <tr><td>Password hash</td><td>Lifetime of account; deleted upon account deletion</td></tr>
            <tr><td>VIP Membership records (Operator-side)</td><td>7 years after expiry (Estonian Accounting Act § 83)</td></tr>
            <tr><td>51.la analytics</td><td>2 years (processor default)</td></tr>
            <tr><td>Email alert configuration</td><td>Until modified/deleted + 30 days after account deletion</td></tr>
            <tr><td>Alert delivery logs</td><td>180 days</td></tr>
            <tr><td>Payment records (Operator-side)</td><td>7 years (accounting)</td></tr>
            <tr><td>Guestbook / configuration hall content</td><td>For as long as the feature operates; removable by you at any time</td></tr>
            <tr><td>Security and anti-abuse records</td><td>180 days</td></tr>
            <tr><td>Character-transfer review decisions (IP addresses partially masked)</td><td>Retained with administrative audit records</td></tr>
          </tbody>
        </table>
      `,
    },
    {
      heading: "7. Your Rights Under GDPR (Articles 15–22)",
      body: `
        <p>You have the right to: access a copy of all personal data we hold about you; rectify inaccurate data; erase your data ("Right to be forgotten", subject to legal retention exceptions); restrict how we process your data; receive your data in a structured, machine-readable format; object to processing based on legitimate interest (Art. 6(1)(f)) at any time; withdraw any consent-based processing at any time (withdrawal does not affect prior processing); and not be subject to automated decision-making producing legal or similarly significant effects.</p>
        <p>To exercise any of these rights, email <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>. We will respond within 30 days (extendable to 60 days for complex requests). No fee is charged for reasonable requests.</p>
      `,
    },
    {
      heading: "8. Cookies",
      body: `
        <p><strong>Essential cookies</strong>: Session cookies for login state management — necessary for the Service to function, no consent required. <strong>Local storage</strong>: A random device identifier used solely for security and abuse prevention — strictly necessary, no consent required. <strong>Analytics cookies</strong>: Set by 51.la to track anonymous session data. Opt out via browser settings or a global tool such as <a href="https://www.youronlinechoices.eu" target="_blank" rel="noopener noreferrer">youronlinechoices.eu</a>.</p>
      `,
    },
    {
      heading: "9. Data Security",
      body: `
        <p>All pages served over HTTPS (TLS 1.2+). Passwords are never stored in plaintext; account verification uses salted, keyed HMAC-SHA-256 values with server-managed key versions. No card numbers or CVC values ever touch our infrastructure — handled exclusively by Stripe. Regular security reviews and dependency updates.</p>
      `,
    },
    {
      heading: "10. Children's Privacy",
      body: `
        <p>The Terms require you to be at least 18 to register or purchase paid services. The Service is not directed at individuals under 18. We do not knowingly collect personal data from individuals under 18. If we become aware that we have collected such data, we will delete it promptly.</p>
      `,
    },
    {
      heading: "11. Automated Decision-Making and Profiling",
      body: `
        <p>We do NOT perform automated decision-making that has legal effects on you, nor do we use profiling for targeted advertising or user segmentation. Analytics data is used only in aggregate form for product improvement.</p>
      `,
    },
    {
      heading: "12. International Data Transfers",
      body: `
        <p>The only non-EU processor is 51.la (China). Data transferred to 51.la is limited to anonymized session data and IP addresses that are anonymized within 24 hours — never linked to an identifiable individual. Transfers are covered by Standard Contractual Clauses (SCCs) per EU Commission Decision 2021/914. All other processing occurs within the European Union (Operator servers are hosted in the EU; Stripe is based in Ireland, EU).</p>
      `,
    },
    {
      heading: "13. Complaints",
      body: `
        <p>If you believe our processing violates the GDPR, you have the right to lodge a complaint with the Estonian Data Protection Inspectorate (Andmekaitse Inspektsioon): <a href="${EE_DATA_PROTECTION_URL}" target="_blank" rel="noopener noreferrer">${EE_DATA_PROTECTION_URL}</a>.</p>
      `,
    },
    {
      heading: "14. Changes to This Policy",
      body: `
        <p>We may update this Policy from time to time. Changes will be posted on this page with a revised "Last updated" date. Substantial changes affecting existing members will be communicated via email at least 30 days before taking effect.</p>
      `,
    },
    {
      heading: "15. Contact",
      body: `
        <p>For any privacy-related questions, to exercise your GDPR rights, or to report a suspected data breach: <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a></p>
      `,
    },
  ],
};

export function mountPrivacyPage(root: HTMLElement): void {
  mountLegalPage(root, CONFIG, "Privacy Policy · LastRO Market Index");
}
