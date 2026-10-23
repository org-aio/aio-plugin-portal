/**
 * 期望态协调器：对每条登记依次执行
 *   desired -> plan -> (可选) apply -> verify
 * 任何 provider 的 blocked 计划都不会被 apply；结果用于 doctor 与 CI。
 */
import type {Alias, PortalSettings} from '../config/index.js';
import {readAliases} from './registry.js';
import {providersFor, type Change, type Plan} from './providers.js';

export type AliasReport = {
  alias: string;
  visibility: string;
  plans: Plan[];
  applied: string[];
  verify: {provider: string; ok: boolean; detail: string}[];
  ok: boolean;
};

export type ReconcileReport = {items: AliasReport[]; ok: boolean};

export async function reconcile(settings: PortalSettings, options: {apply?: boolean; alias?: string} = {}): Promise<ReconcileReport> {
  const aliases = readAliases(settings).filter(item => !options.alias || item.alias === options.alias);
  const items: AliasReport[] = [];
  for (const item of aliases) {
    const plans: Plan[] = [];
    const applied: string[] = [];
    const verify: AliasReport['verify'] = [];
    for (const provider of providersFor(settings, item)) {
      const plan = await provider.plan(item, settings);
      plans.push(plan);
      if (options.apply && !plan.blocked) {
        await provider.apply(item, settings, plan);
        applied.push(provider.name);
      }
      const result = await provider.verify(item, settings);
      verify.push({provider: provider.name, ...result});
    }
    items.push({
      alias: item.alias,
      visibility: item.visibility ?? 'internal',
      plans,
      applied,
      verify,
      ok: plans.every(plan => !plan.blocked) && verify.every(result => result.ok),
    });
  }
  return {items, ok: items.every(item => item.ok)};
}

export function formatReport(report: ReconcileReport): string {
  const lines: string[] = [];
  for (const item of report.items) {
    lines.push(`${item.alias} (${item.visibility}) ${item.ok ? 'OK' : 'NEEDS ATTENTION'}`);
    for (const plan of item.plans) {
      const changes = plan.changes.length ? plan.changes : [{kind: 'noop' as const, resource: plan.provider, detail: '无变更'} as Change];
      for (const change of changes) lines.push(`  [${plan.provider}] ${change.kind} ${change.resource} ${change.detail}`);
      for (const warning of plan.warnings) lines.push(`  [${plan.provider}] warning: ${warning}`);
    }
    for (const result of item.verify) lines.push(`  [${result.provider}] verify ${result.ok ? 'ok' : 'failed'}: ${result.detail}`);
  }
  lines.push(report.ok ? '协调完成' : '存在未满足的 provider 计划或校验');
  return lines.join('\n');
}
