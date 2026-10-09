/**
 * @file Anomaly notices: on a twin, and across the plant.
 *
 * One notice per open investigation, in the state the agent has reached:
 *
 * - **reported**: "Critical anomaly detected" (alarm or critical level) or
 *   "Anomaly detected", the report's headline, and a button to read it.
 * - **analysing**: the detector fired and the agent is working on it.
 * - **agent unavailable or failed**: the ordinary alarm still stands; the
 *   notice says why there is no report and how to start the agent.
 *
 * Bordered notices with an icon, no tinted fill, no coloured side stripe. The
 * open investigations come from the API (refreshed by `agent:status` and
 * `agent:alert`); a socket alert fills the headline in before the refetch.
 *
 * @module features/agent/components/AgentAlertBanner
 */

import { Link } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import Button from '../../../components/ui/Button.jsx';
import Icon from '../../../components/ui/Icon.jsx';
import { FileText, Warning, WarningOctagon, X } from '../../../components/ui/icons.js';
import { useGetAssetsQuery } from '../../assets/assetsApiSlice.js';
import { useGetInvestigationsQuery, useGetReportsQuery } from '../agentApiSlice.js';
import { alertDismissed, reportOpened, selectAgent } from '../agentSlice.js';
import { selectDeviceList } from '../../telemetry/telemetrySlice.js';
import { anomalyTitle, channelWords, machineLabel } from './levels.js';

const LIMIT_WORDS = {
  warnLow: 'is below its warning limit',
  alarmLow: 'is below its alarm limit',
  warnHigh: 'is above its warning limit',
  alarmHigh: 'is above its alarm limit',
};

/** @param {any} inv */
function triggerText(inv) {
  const channel = channelWords(inv.channelKey);
  const what = channel ? channel[0].toUpperCase() + channel.slice(1) : 'A channel';
  if (inv.kind === 'drift') return `${what} is drifting away from its learned baseline.`;
  return `${what} ${LIMIT_WORDS[inv.trigger?.limitName] ?? 'is past a limit'}.`;
}

/**
 * Merge open investigations with their reports and any alert that arrived first.
 *
 * @param {any[]} investigations
 * @param {any[]} reports
 * @param {any[]} alerts
 */
function noticesOf(investigations, reports, alerts) {
  return investigations.map((inv) => {
    const report =
      (inv.reportId && (reports.find((r) => r.id === inv.reportId) ?? alerts.find((a) => a.reportId === inv.reportId))) ||
      alerts.find((a) => a.investigationId === inv.id) ||
      null;
    return { inv, report, reportId: inv.reportId ?? report?.reportId ?? report?.id ?? null };
  });
}

/** @param {{label?: string}} props */
function Spinner({ label = 'Analysing' }) {
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-secondary border-t-transparent"
    />
  );
}

/**
 * Notices for one twin, under its toolbar.
 *
 * @param {{assetId: string}} props
 * @returns {import('react').JSX.Element|null}
 */
export function TwinAlertBanner({ assetId }) {
  const dispatch = useAppDispatch();
  const { alerts, dismissed } = useAppSelector(selectAgent);
  const devices = useAppSelector(selectDeviceList);
  const { data: investigations = [] } = useGetInvestigationsQuery({ assetId });
  const { data: reports = [] } = useGetReportsQuery({ assetId, limit: 10 });

  const notices = noticesOf(investigations, reports, alerts).filter(({ inv, reportId }) => !dismissed[reportId ?? inv.id]);
  if (!notices.length) return null;

  return (
    <div className="shrink-0 space-y-2 border-b border-line bg-surface px-4 py-2.5">
      {notices.slice(0, 2).map(({ inv, report, reportId }) => {
        const machine = machineLabel(inv.machineId, devices);
        const dismiss = (
          <Button
            variant="ghost"
            size="icon"
            icon={X}
            onClick={() => dispatch(alertDismissed(reportId ?? inv.id))}
            aria-label={`Dismiss the notice for ${machine}`}
            title="Dismiss"
            className="!h-8 !w-8"
          />
        );

        if (reportId) {
          return (
            <div key={inv.id} role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-danger bg-raised px-4 py-2">
              <Icon icon={WarningOctagon} size={20} className="text-danger" />
              <p className="min-w-0 flex-1 text-[13px] text-ink">
                <strong className="font-semibold text-danger">{anomalyTitle(report?.level)}.</strong>{' '}
                {report?.headline ?? `${machine}: ${triggerText(inv)}`}
              </p>
              <Button size="sm" icon={FileText} onClick={() => dispatch(reportOpened(reportId))}>
                View diagnostic report
              </Button>
              {dismiss}
            </div>
          );
        }

        const unavailable = inv.status === 'agent_unavailable' || inv.status === 'failed';
        return (
          <div key={inv.id} role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-control bg-raised px-4 py-2">
            {unavailable ? <Icon icon={Warning} size={20} className="text-warning" /> : <Spinner />}
            <p className="min-w-0 flex-1 text-[13px] text-ink">
              <strong className="font-semibold">Anomaly on {machine}.</strong> {triggerText(inv)}{' '}
              {inv.status === 'failed'
                ? 'The diagnosis could not be completed; the alarm on the channel still applies.'
                : unavailable
                  ? 'The diagnosis agent is not running, so there is no report yet. Start it with npm run agent.'
                  : 'The diagnosis agent is analysing it.'}
            </p>
            {dismiss}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Notices for the whole plant, under the console header, linking to each twin.
 *
 * @returns {import('react').JSX.Element|null}
 */
export function PlantAlertBanner() {
  const dispatch = useAppDispatch();
  const { alerts, dismissed } = useAppSelector(selectAgent);
  const devices = useAppSelector(selectDeviceList);
  const { data: investigations = [] } = useGetInvestigationsQuery({});
  const { data: reports = [] } = useGetReportsQuery({ limit: 10 });
  const { data: assets } = useGetAssetsQuery({ limit: 50 });
  const nameOf = (id) => assets?.items?.find((a) => (a.id ?? a._id) === id)?.name ?? 'a twin';

  const notices = noticesOf(investigations, reports, alerts).filter(({ inv, reportId }) => !dismissed[reportId ?? inv.id]);
  if (!notices.length) return null;

  return (
    <div className="border-b border-line bg-surface">
      <ul className="mx-auto max-w-[1600px] space-y-2 px-6 py-2.5" aria-label="Open anomalies">
        {notices.slice(0, 3).map(({ inv, report, reportId }) => {
          const where = `${nameOf(inv.assetId)}, ${machineLabel(inv.machineId, devices)}`;
          const to = inv.assetId ? `/assets/${inv.assetId}/twin${reportId ? `?report=${reportId}` : ''}` : null;
          return (
            <li
              key={inv.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 border bg-raised px-4 py-2 ${reportId ? 'border-danger' : 'border-control'}`}
            >
              {reportId ? <Icon icon={WarningOctagon} size={20} className="text-danger" /> : <Spinner />}
              <p className="min-w-0 flex-1 text-[13px] text-ink">
                <strong className={`font-semibold ${reportId ? 'text-danger' : ''}`}>
                  {reportId ? `${anomalyTitle(report?.level)} on ${where}.` : `Anomaly on ${where}.`}
                </strong>{' '}
                {reportId ? (report?.headline ?? triggerText(inv)) : `${triggerText(inv)} The diagnosis agent is analysing it.`}
              </p>
              {to ? (
                <Link to={to} className="text-[13px] font-medium text-primary underline underline-offset-4 hover:text-primary-hover">
                  {reportId ? 'Open the report on the twin' : 'Open the twin'}
                </Link>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                icon={X}
                onClick={() => dispatch(alertDismissed(reportId ?? inv.id))}
                aria-label={`Dismiss the notice for ${where}`}
                title="Dismiss"
                className="!h-8 !w-8"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default TwinAlertBanner;
