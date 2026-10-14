import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function secret(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const completeInput = {
  requestedEnabled: 'true',
  authSiteUrl: 'https://auth.ltsd.ro',
  mailFrom: 'LTSD <no-reply@auth.ltsd.ro>',
  mailReplyTo: 'support@ltsd.ro',
  passwordSecret: secret(1),
  csrfSecret: secret(2),
  rateSecret: secret(3),
  mailPayloadSecret: secret(4),
  resendApiKey: 're_test-key',
  passwordKeyVersion: '1',
  mailPayloadKeyVersion: '1',
  mailDailyLimit: '100',
  mailMonthlyLimit: '3000',
};

async function runPreflight(input: Record<string, string | undefined>) {
  const moduleUrl = new URL('../../../scripts/preflight-auth-deployment.mjs', import.meta.url);
  const module = await import(moduleUrl.href) as {
    resolveAuthDeploymentPreflight(values: Record<string, string | undefined>): { enabled: boolean; reasonCodes: string[] };
  };
  return module.resolveAuthDeploymentPreflight(input);
}

describe('production auth deployment preflight', () => {
  it('keeps auth off unless production explicitly requests it', async () => {
    expect(await runPreflight({ requestedEnabled: 'false' })).toMatchObject({ enabled: false });
  });

  it('fails closed with a redacted reason when a required secret is missing', async () => {
    const result = await runPreflight({ ...completeInput, rateSecret: undefined });

    expect(result.enabled).toBe(false);
    expect(result.reasonCodes).toContain('MISSING_REQUIRED_SECRET');
    expect(JSON.stringify(result)).not.toContain(completeInput.passwordSecret);
    expect(JSON.stringify(result)).not.toContain(completeInput.authSiteUrl);
  });

  it('enables only a complete set of valid secrets and mail configuration', async () => {
    expect(await runPreflight(completeInput)).toEqual({ enabled: true, reasonCodes: [] });
  });

  it('rejects an incomplete previous-key pair rather than dropping a rotation key', async () => {
    const result = await runPreflight({
      ...completeInput, passwordPreviousKeyVersion: 'old', passwordPreviousSecret: undefined,
    });

    expect(result.enabled).toBe(false);
    expect(result.reasonCodes).toContain('INCOMPLETE_PASSWORD_PREVIOUS_KEY_PAIR');
  });

  it('publishes the auth-disabled barrier before secret rotation and only re-enables in the final deploy', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const barrierIndex = workflow.indexOf('name: Publish auth-disabled rotation barrier');
    const secretsIndex = workflow.indexOf('name: Set Worker account auth secrets');
    const deployIndex = workflow.indexOf('name: Deploy production Worker and web assets');

    expect(barrierIndex).toBeGreaterThanOrEqual(0);
    expect(secretsIndex).toBeGreaterThan(barrierIndex);
    expect(deployIndex).toBeGreaterThan(secretsIndex);

    const barrier = workflow.slice(barrierIndex, secretsIndex);
    expect(barrier).toContain("if: steps.auth-preflight.outputs.enabled == 'true'");
    expect(barrier).toContain('--var "AUTH_ENABLED:false"');

    const authSecrets = workflow.slice(secretsIndex, deployIndex);
    expect(authSecrets).toContain("if: steps.auth-preflight.outputs.enabled == 'true'");
    expect(authSecrets).toContain('wrangler secret put "$name"');

    const finalDeploy = workflow.slice(deployIndex);
    expect(finalDeploy).toContain('auth_enabled="$AUTH_ENABLED"');
    expect(finalDeploy).toContain('AUTH_ENABLED: ${{ steps.auth-preflight.outputs.enabled }}');
  });
});
