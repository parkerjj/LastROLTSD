/**
 * Terms of Service (/terms).
 * English is the authoritative version.
 */

import { mountLegalPage, type LegalPageConfig } from "./legal-page";
import { EU_ODR_URL, LEGAL_EMAIL, SUPPORT_EMAIL } from "./legal-constants";

const CONFIG: LegalPageConfig = {
  pageTitle: "Terms of Service",
  pageSlug: "/terms",
  subtitle: "Governing your use of LastRO Market Index — EU / Estonia jurisdiction",
  sections: [
    {
      heading: "1. Scope and Eligibility",
      body: `
        <p>These Terms of Service ("Terms") govern your use of the LastRO Market Index website (the "Service") operated by Yue Liu (füüsilisest isikust ettevõtja, sole trader, registry code 16984560, the "Operator", "we", "us"). By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service. You must be at least 18 years old to register an account or purchase paid services.</p>
      `,
    },
    {
      heading: "2. Service Description",
      body: `
        <p>The Service provides two tiers:</p>
        <ul>
          <li><strong>Free features</strong>: real-time Ragnarok Online (LastRO private server) market item search, price history charts, map-based shop location tools, a monitoring dashboard, a community configuration sharing hall, and a guestbook.</li>
          <li><strong>Paid features ("VIP Membership")</strong>: market data exports (CSV), 90-day price trend analysis, monitoring dashboard account slot expansion (up to 20), email-based offline / death / weight alerts, member identity badges, priority bug support, and early access to experimental features.</li>
        </ul>
        <p>The Service does NOT provide, distribute, or license the Ragnarok Online game client, game content, or any intellectual property owned by Gravity Co., Ltd. or its affiliates. Market data is compiled from publicly observable in-game shop records and is provided for informational purposes only.</p>
      `,
    },
    {
      heading: "3. Account Registration",
      body: `
        <p>Registration requires a valid email address and a password. You are responsible for maintaining the security of your account credentials and for all activities that occur under your account. The Operator reserves the right to suspend or terminate accounts that violate these Terms or engage in abusive behavior.</p>
      `,
    },
    {
      heading: "4. Paid Services — VIP Membership",
      body: `
        <p><strong>4.1 Membership plans.</strong> Sold as prepaid digital access via Stripe (/vip/price): 1 month (¥30), 3 months (¥78), 12 months (¥268), perpetual access (¥588). All prices in CNY.</p>
        <p><strong>4.2 Non-recurring.</strong> All plans are one-time payments. There is NO automatic renewal. At expiry, your account reverts to free-tier access.</p>
        <p><strong>4.3 Activation.</strong> Membership is bound to your LTSD account (not your in-game character). Activates within seconds of successful payment via Stripe callback.</p>
        <p><strong>4.4 Waiver of 14-day withdrawal right (EU Consumer Rights Directive 2011/83/EU Article 16(b)).</strong> By purchasing VIP Membership, you request immediate delivery of digital content during the statutory 14-day withdrawal period. You expressly consent to the performance beginning before the end of the withdrawal period and acknowledge that you will LOSE your statutory 14-day right of withdrawal once the digital content has been fully delivered. Perpetual plans also constitute immediate delivery and are not subject to withdrawal.</p>
      `,
    },
    {
      heading: "5. Payment Processing",
      body: `
        <p>All payments are processed by Stripe Payments Europe, Ltd. (Ireland, EU). The Operator never stores your full credit card number, CVC, or bank account details. Stripe handles all payment data under its own PCI DSS compliance framework. Available methods: Alipay (via Stripe checkout), Visa, Mastercard, JCB, Apple Pay, Google Pay.</p>
      `,
    },
    {
      heading: "6. Acceptable Use",
      body: `
        <p>You agree NOT to: use the Service to cheat, automate, or violate any rules of the LastRO private server or the Ragnarok Online Terms of Service; attempt to reverse-engineer, scrape, or DDoS the Service; interfere with or circumvent security measures, access controls, or rate limits; upload or share content that is illegal, harmful, defamatory, infringing, or abusive; use the Service for any purpose that violates applicable law in Estonia, the EU, or your jurisdiction of residence.</p>
      `,
    },
    {
      heading: "7. Intellectual Property",
      body: `
        <p>Website design, code, branding, and original content created by the Operator remain the intellectual property of the Operator. Public market data originates from in-game observations; the Operator does not claim ownership of any Ragnarok Online intellectual property belonging to Gravity Co., Ltd. User-generated content (guestbook posts, configuration profiles) remains your property. By publishing on the Service, you grant the Operator a non-exclusive, worldwide, royalty-free license to display and host that content for the purpose of operating the Service.</p>
      `,
    },
    {
      heading: "8. Third-Party Links",
      body: `
        <p>The Service may contain links to third-party websites. The Operator has no control over and is not responsible for the content, privacy practices, or availability of any third-party site.</p>
      `,
    },
    {
      heading: "9. Service Availability and Changes",
      body: `
        <p>The Service is provided "as is" and "as available". The Operator does not guarantee uninterrupted, error-free, or secure operation. Planned maintenance windows will be posted on the /updates page. The Operator reserves the right to modify, suspend, or discontinue the Service or any paid feature at any time. Material reductions to paid benefits will be communicated via email to affected members at least 14 days in advance, except where urgent security fixes are required. If VIP Membership benefits are materially reduced, members will receive a pro-rated refund for the unused portion: <code>(remaining_days ÷ original_plan_duration_days) × purchase_amount</code>.</p>
      `,
    },
    {
      heading: "10. Disclaimers",
      body: `
        <p>Market prices, item availability, and shop locations are provided for reference only — in-game conditions may differ. The Operator has no affiliation with, and does not endorse, the LastRO private server operator. Game bans, character loss, or account actions taken by the game server operator are outside the Operator's control.</p>
      `,
    },
    {
      heading: "11. Limitation of Liability",
      body: `
        <p>To the maximum extent permitted by applicable law, the Operator shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or any loss of profits or data arising from or related to your use of the Service. The Operator's total liability for any claim arising from these Terms shall not exceed the amount you paid to the Operator in the 12 months preceding the claim. Nothing in these Terms shall exclude or limit liability for personal injury or death caused by our negligence, or liability that cannot be excluded under applicable law.</p>
      `,
    },
    {
      heading: "12. Termination",
      body: `
        <p>Either party may terminate the relationship at any time by ceasing use of the Service. The Operator may suspend or terminate your account immediately if you violate these Terms. Upon termination, your right to use VIP features ceases.</p>
      `,
    },
    {
      heading: "13. Applicable Law and Dispute Resolution",
      body: `
        <p>These Terms are governed by and construed in accordance with the laws of the Republic of Estonia, excluding its conflict of law principles. Any dispute arising from these Terms shall first be resolved through good-faith negotiation via <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a>. If negotiations fail, disputes shall be submitted to the courts of Tallinn, Estonia. Consumer disputes may also be submitted to the European Commission's Online Dispute Resolution (ODR) platform: <a href="${EU_ODR_URL}" target="_blank" rel="noopener noreferrer">${EU_ODR_URL}</a>.</p>
      `,
    },
    {
      heading: "14. Changes to These Terms",
      body: `
        <p>We may update these Terms from time to time. Changes will be posted on this page with a revised "Last updated" date. Continued use of the Service after changes constitutes your acceptance of the updated Terms.</p>
      `,
    },
    {
      heading: "15. Contact",
      body: `
        <p>For legal inquiries: <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a> · Refund support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
      `,
    },
  ],
};

export function mountTermsPage(root: HTMLElement): void {
  mountLegalPage(root, CONFIG, "Terms of Service · LastRO Market Index");
}
