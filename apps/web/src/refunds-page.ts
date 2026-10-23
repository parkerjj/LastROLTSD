/**
 * Refund Policy (/refunds).
 * English is the authoritative version.
 * Applicable law: EU Consumer Rights Directive 2011/83/EU Article 16(b).
 */

import { mountLegalPage, type LegalPageConfig } from "./legal-page";
import { LEGAL_EMAIL, SUPPORT_EMAIL } from "./legal-constants";

const CONFIG: LegalPageConfig = {
  pageTitle: "Refund Policy",
  pageSlug: "/refunds",
  subtitle: "Digital content refunds — EU Consumer Rights Directive 2011/83/EU Article 16(b)",
  sections: [
    {
      heading: "1. Scope",
      body: `
        <p>This Refund Policy applies to all digital payment transactions made through the Operator's VIP Membership offering, processed by Stripe. This policy does NOT cover in-game transactions, donations, or any payments to third parties.</p>
      `,
    },
    {
      heading: "2. Default Rule — No Refunds for Digital Content",
      body: `
        <p>Pursuant to the EU Consumer Rights Directive 2011/83/EU (Article 16(b)), the statutory 14-day right of withdrawal does NOT apply to the supply of digital content that is not supplied on a tangible medium, when both of these conditions are met:</p>
        <ol>
          <li>You have given prior express consent to begin the performance during the withdrawal period, AND</li>
          <li>You have acknowledged that you thereby lose your right of withdrawal.</li>
        </ol>
        <p>By purchasing VIP Membership at checkout, you explicitly consent to immediate delivery of digital enhanced service access before the withdrawal period ends and acknowledge that you will lose your 14-day statutory right of withdrawal once delivery is complete.</p>
      `,
    },
    {
      heading: "3. Exceptions — When We DO Offer Refunds",
      body: `
        <p>A refund request may be granted in the following circumstances:</p>
        <h3 class="legal-subheading">3.1 Failure to Deliver Paid Benefits</h3>
        <p>If VIP benefits are not activated within 24 hours of confirmed payment, and the issue cannot be resolved within 72 hours of your report, a full refund of the purchase amount will be offered.</p>
        <h3 class="legal-subheading">3.2 Pro-Rated Refund on Material Downgrade</h3>
        <p>If the Operator materially reduces VIP benefits (e.g., permanently removes a featured data export, shuts down a promised alert channel) without providing a 14-day advance notice, affected members may request a pro-rated refund of the remaining plan duration. Calculation: <code>(remaining_days ÷ original_plan_duration_days) × purchase_amount</code>.</p>
        <h3 class="legal-subheading">3.3 Perpetual Plans — Limited Refund Window</h3>
        <p>Perpetual plans are fully non-refundable UNLESS the Operator permanently ceases operation within 12 months of purchase, in which case a pro-rated refund based on the elapsed period may be offered at the Operator's sole discretion.</p>
      `,
    },
    {
      heading: "4. Refund Process",
      body: `
        <p><strong>4.1 Eligibility.</strong> Only VIP Membership purchases made in the last 30 days are eligible for refund consideration, except Section 3.3.</p>
        <p><strong>4.2 How to Request.</strong> Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with your Stripe payment confirmation details (transaction reference or invoice number found in your Stripe receipt) and the reason.</p>
        <p><strong>4.3 Review.</strong> Refund requests are reviewed within 3–5 business days.</p>
        <p><strong>4.4 Processing.</strong> Approved refunds are processed through Stripe back to your original payment method. Stripe refund processing typically takes 5–10 business days depending on your payment provider.</p>
        <p><strong>4.5 Non-refundable fees.</strong> Processing fees charged by Stripe are non-refundable.</p>
      `,
    },
    {
      heading: "5. Non-Refundable in All Cases",
      body: `
        <ul>
          <li><strong>Partial usage.</strong> Once VIP benefits have been activated and used, no partial refund is available for any subscription duration.</li>
          <li><strong>Accounts terminated</strong> for Terms of Service violations.</li>
          <li><strong>Requests made more than 30 days</strong> after purchase (except Section 3.3 above).</li>
          <li><strong>Donations / sponsor page payments</strong>.</li>
          <li>Any dispute or request circumventing the Operator's refund process (chargebacks without prior contact may result in account suspension).</li>
        </ul>
      `,
    },
    {
      heading: "6. Business / Commercial Purchases",
      body: `
        <p>Purchases made for business or commercial purposes, or by individuals not acting in a consumer capacity, are not eligible for any statutory right of withdrawal and are governed solely by the Terms of Service.</p>
      `,
    },
    {
      heading: "7. Contact",
      body: `
        <p><strong>Refund requests</strong>: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
        <p><strong>General legal questions</strong>: <a href="mailto:${LEGAL_EMAIL}">${LEGAL_EMAIL}</a></p>
      `,
    },
  ],
};

export function mountRefundsPage(root: HTMLElement): void {
  mountLegalPage(root, CONFIG, "Refund Policy · LastRO Market Index");
}
