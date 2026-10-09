/**
 * @file A diagnostic report, read in the twin's inspector column.
 *
 * Top to bottom in the order an engineer checks a diagnosis: what is wrong and
 * how sure the agent is, why (the summary with its sources), what each test
 * showed, what to do, what else it could be, and which pages of the manuals
 * back it. "Show on model" lights the named parts and frames the first.
 *
 * @module features/agent/components/DiagnosticReportPanel
 */

import { useEffect } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import Button from '../../../components/ui/Button.jsx';
import { ErrorState } from '../../../components/ui/Feedback.jsx';
import { Crosshair, X } from '../../../components/ui/icons.js';
import { SkeletonText } from '../../../components/ui/Skeleton.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { selectIsModelLoaded } from '../../twin-viewer/twinViewerSlice.js';
import { useGetReportQuery } from '../agentApiSlice.js';
import { reportClosed } from '../agentSlice.js';
import { showTargets } from '../uiCommands.js';
import { CitationList, CitedText } from './CitedText.jsx';
import { selectDeviceList } from '../../telemetry/telemetrySlice.js';
import { levelOf, machineLabel, percent } from './levels.js';

const VERDICT = { supports: 'Supports', contradicts: 'Against', neutral: 'Neutral' };

/** @param {{label: string, children: import('react').ReactNode}} props */
function Section({ label, children }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <h3 className="label-text">{label}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * @param {object} props
 * @param {string} props.reportId
 * @returns {import('react').JSX.Element}
 */
export function DiagnosticReportPanel({ reportId }) {
  const dispatch = useAppDispatch();
  const { data: report, isLoading, isError, error, refetch } = useGetReportQuery(reportId);
  const modelLoaded = useAppSelector(selectIsModelLoaded);
  const devices = useAppSelector(selectDeviceList);

  // Opening a report shows its parts once, so the reader sees where to look. It
  // waits for the model: a camera command sent before the scene exists is lost.
  useEffect(() => {
    if (modelLoaded && report?.targets?.length) dispatch(showTargets(report.targets));
  }, [dispatch, report?.id, modelLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <header className="flex items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <h2 className="display-section">Diagnostic report</h2>
        <p className="label-text">
          {report ? (
            <>
              {machineLabel(report.machineId, devices)},{' '}
              <span className="font-mono">{new Date(report.createdAt).toLocaleString()}</span>
            </>
          ) : (
            'From the diagnosis agent'
          )}
        </p>
      </div>
      <Button variant="ghost" size="icon" icon={X} onClick={() => dispatch(reportClosed())} aria-label="Close the report" title="Close" />
    </header>
  );

  if (isLoading) {
    return (
      <div aria-busy="true">
        {header}
        <div className="space-y-6 px-5 pb-5">
          <SkeletonText lines={2} />
          <SkeletonText lines={4} />
          <SkeletonText lines={3} />
        </div>
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div>
        {header}
        <div className="px-5 pb-5">
          <ErrorState
            title="Report unavailable"
            message={getErrorMessage(error) || 'The report could not be loaded.'}
            action={<Button size="sm" onClick={refetch}>Retry request</Button>}
          />
        </div>
      </div>
    );
  }

  const level = levelOf(report.level);
  const root = report.rootCause ?? {};
  const anchor = `report-${report.id}`;

  return (
    <article aria-label="Diagnostic report">
      {header}

      <div className="px-5 pb-4">
        <p className="text-[15px] font-semibold leading-[22px] text-ink">{report.headline}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <StatusMarker state={level.marker} label={`Level: ${level.label}`} />
          {report.needsReview ? <span className="text-[13px] text-warning">Needs a person to review</span> : null}
        </div>
      </div>

      <Section label="Most likely cause">
        <p className="text-[14px] font-medium text-ink">
          {root.name}{' '}
          {root.faultCode || root.id ? (
            <span className="font-mono text-[13px] font-normal text-ink-secondary">
              {[root.id, root.faultCode].filter(Boolean).join(' ')}
            </span>
          ) : null}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <span className="font-mono text-[13px] text-ink" aria-label={`Confidence ${percent(root.confidence)}`}>
            {percent(root.confidence)}
          </span>
          <span aria-hidden="true" className="h-1.5 flex-1 bg-sunken">
            <span className="block h-full bg-ink-secondary" style={{ width: percent(root.confidence) }} />
          </span>
          <span className="label-text">confidence</span>
        </div>
        {report.targets?.length ? (
          <div className="mt-3">
            <Button size="sm" icon={Crosshair} onClick={() => dispatch(showTargets(report.targets))}>
              Show on model
            </Button>
            <p className="label-text mt-1.5">{report.targets.map((t) => t.label ?? t.meshName).join(', ')}</p>
          </div>
        ) : null}
      </Section>

      {report.summary ? (
        <Section label="Why">
          <div className="text-[14px] leading-[22px] text-ink-secondary">
            <CitedText text={report.summary} anchor={anchor} />
          </div>
        </Section>
      ) : null}

      {report.evidence?.length ? (
        <Section label="Tests against the documented signatures">
          <ul className="divide-y divide-line border-y border-line">
            {report.evidence.map((e, i) => (
              <li key={i} className="py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{e.test}</span>
                  <span className={`shrink-0 text-[12px] ${e.verdict === 'supports' ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
                    {VERDICT[e.verdict] ?? e.verdict}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[12px] text-ink">{e.observed}</p>
                <p className="text-[12px] leading-4 text-ink-muted">{e.expected}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.actions?.length ? (
        <Section label="What to do">
          <ol className="list-decimal space-y-2 pl-5 text-[14px] text-ink">
            {report.actions.map((a, i) => (
              <li key={i}>
                {a.step}
                {a.caveat ? <span className="block text-[12px] leading-4 text-ink-muted">{a.caveat}</span> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {report.alternatives?.length ? (
        <Section label="Also considered">
          <ul className="space-y-1">
            {report.alternatives.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 text-[13px] text-ink-secondary">
                <span>
                  {a.name} <span className="font-mono text-[12px] text-ink-muted">{a.id}</span>
                </span>
                <span className="font-mono text-ink">{percent(a.confidence)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {report.needsBinding?.length ? (
        <Section label="Channels not bound to a part">
          <p className="font-mono text-[12px] leading-5 text-ink-secondary">{report.needsBinding.join(', ')}</p>
          <p className="label-text mt-1">Bind them from Mappings so their alarms also light the model.</p>
        </Section>
      ) : null}

      {report.citations?.length ? (
        <Section label="Sources">
          <CitationList citations={report.citations} anchor={anchor} title="Machine manuals" />
        </Section>
      ) : null}

      <footer className="border-t border-line px-5 py-3">
        <p className="label-text">
          {report.generatedBy === 'agent' && report.model
            ? `Written by the diagnosis agent with ${report.model}.`
            : 'Written by the diagnosis agent from rules and the manuals, without the language model.'}{' '}
          <span className="font-mono">{report.id}</span>
        </p>
      </footer>
    </article>
  );
}

export default DiagnosticReportPanel;
