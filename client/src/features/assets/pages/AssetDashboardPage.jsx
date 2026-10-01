/**
 * @file Asset registry — the console's landing view.
 *
 * @module features/assets/pages/AssetDashboardPage
 */

import { Link, useSearchParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import PageHeader from '../../../components/ui/PageHeader.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import { SearchField } from '../../../components/ui/Field.jsx';
import { Plus } from '../../../components/ui/icons.js';
import { Segmented } from '../../../components/ui/Segmented.jsx';
import StatusPill, { RatchetGlyph, Tag } from '../../../components/ui/StatusPill.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { formatBytes } from '../../../lib/three-helpers.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useGetAssetsQuery } from '../assetsApiSlice.js';

/** @type {Array<{value: string, label: string}>} */
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending_conversion', label: 'Pending' },
  { value: 'converted', label: 'Converted' },
  { value: 'mapped', label: 'Instrumented' },
];

/**
 * The status ratchet as one proportional bar.
 *
 * Three segments sized by how many assets sit at each stage. They differ by
 * fill (hollow, mid, solid), not by hue, and each is named in the caption, so
 * the bar reads without colour. With no assets it is a single hollow outline.
 *
 * @param {object} props
 * @param {number} props.pending
 * @param {number} props.converted
 * @param {number} props.mapped
 * @returns {import('react').JSX.Element}
 */
function RatchetBar({ pending, converted, mapped }) {
  const total = pending + converted + mapped;
  const segments = [
    { key: 'pending', count: pending, className: 'border border-control bg-transparent' },
    { key: 'converted', count: converted, className: 'border border-ink-muted bg-ink-muted' },
    { key: 'mapped', count: mapped, className: 'border border-ink bg-ink' },
  ];

  return (
    <div
      role="img"
      aria-label={`${total} asset${total === 1 ? '' : 's'} on this page: ${pending} awaiting mesh, ${converted} renderable, ${mapped} instrumented`}
      className="flex h-3 w-full gap-0.5"
    >
      {total === 0 ? (
        <span className="block h-full w-full border border-control" />
      ) : (
        segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className={`block h-full ${segment.className}`}
              style={{ flexGrow: segment.count, flexBasis: 0 }}
            />
          ))
      )}
    </div>
  );
}

/**
 * One cell of the stat strip.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {number} props.value
 * @param {string} props.caption
 * @returns {import('react').JSX.Element}
 */
function Stat({ label, value, caption }) {
  return (
    <div className="px-5 py-4">
      <dt className="label-text text-ink-secondary">{label}</dt>
      <dd className="display-figure mt-2">{value}</dd>
      <dd className="mt-1 text-xs text-ink-muted">{caption}</dd>
    </div>
  );
}

/**
 * @returns {import('react').JSX.Element}
 */
export function AssetDashboardPage() {
  usePageTitle('Asset registry');

  /**
   * Filters live in the URL rather than component state, so a filtered view is
   * bookmarkable and shareable — the guidelines' "URL reflects state" rule.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const search = searchParams.get('search') ?? '';

  const { data, isLoading, isError, error, refetch } = useGetAssetsQuery({
    status: status || undefined,
    search: search || undefined,
  });

  const assets = data?.items ?? [];
  const total = data?.meta?.total ?? 0;

  /**
   * @param {string} key
   * @param {string} value
   */
  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const countBy = (target) => assets.filter((asset) => asset.status === target).length;
  const hasFilters = Boolean(search || status);

  return (
    <div className="space-y-7">
      <PageHeader
        title="Asset registry"
        actions={
          <Button to="/assets/new" variant="primary" icon={Plus}>
            Ingest asset
          </Button>
        }
      />

      {/* ── Stat strip: one ruled band, ratchet bar above the figures ─────── */}
      <section aria-label="Registry summary" className="rule-ink border-b border-line bg-surface">
        <div className="px-5 pt-4">
          <RatchetBar
            pending={countBy('pending_conversion')}
            converted={countBy('converted')}
            mapped={countBy('mapped')}
          />
        </div>
        <dl className="grid grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-line">
          <Stat label="Total assets" value={total} caption="In registry" />
          <Stat label="Awaiting mesh" value={countBy('pending_conversion')} caption="CAD only" />
          <Stat label="Renderable" value={countBy('converted')} caption="Mesh uploaded" />
          <Stat label="Instrumented" value={countBy('mapped')} caption="Sensors bound" />
        </dl>
      </section>

      {/* ── Registry table ───────────────────────────────────────────────── */}
      <Panel
        title="Assets"
        description={`${total} record${total === 1 ? '' : 's'}`}
        flush
        actions={
          <>
            <Segmented
              label="Filter by status"
              options={STATUS_FILTERS}
              value={status}
              onChange={(value) => updateParam('status', value)}
            />
            <SearchField
              label="Search assets by name or uploader"
              value={search}
              onValueChange={(value) => updateParam('search', value)}
              placeholder="Search assets…"
              name="assetSearch"
              className="w-full sm:w-60"
            />
          </>
        }
      >
        {isLoading ? <LoadingState variant="rows" label="Loading registry…" /> : null}

        {isError ? (
          <div className="p-5">
            <ErrorState
              title="Registry unavailable"
              message={getErrorMessage(error)}
              action={
                <Button onClick={refetch} size="sm">
                  Retry request
                </Button>
              }
            />
          </div>
        ) : null}

        {!isLoading && !isError && assets.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No matching assets' : 'The registry is empty'}
            description={
              hasFilters
                ? 'No asset matches the current filters. Clear them to see every record.'
                : 'Ingest a CAD file and its converted mesh to create the first digital twin.'
            }
            action={
              hasFilters ? (
                <Button onClick={() => setSearchParams({}, { replace: true })} size="sm">
                  Clear filters
                </Button>
              ) : (
                <Button to="/assets/new" variant="primary" size="sm" icon={Plus}>
                  Ingest asset
                </Button>
              )
            }
          >
            {hasFilters ? null : (
              // First run: show the three stages an asset will move through.
              <ol className="mt-6 grid gap-3 sm:grid-cols-3">
                {[
                  { filled: 1, name: 'Pending conversion', note: 'Source CAD on record, no mesh yet' },
                  { filled: 2, name: 'Converted', note: 'A .glb mesh renders in the viewer' },
                  { filled: 3, name: 'Instrumented', note: 'At least one sensor is bound' },
                ].map((stage) => (
                  <li key={stage.name} className="border-t border-line pt-3">
                    <div className="flex items-center gap-2">
                      <RatchetGlyph filled={stage.filled} />
                      <span className="text-[13px] font-medium text-ink">{stage.name}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{stage.note}</p>
                  </li>
                ))}
              </ol>
            )}
          </EmptyState>
        ) : null}

        {assets.length > 0 ? (
          // Scroll is contained here so the page body never scrolls sideways.
          // Focusable and labelled, so a keyboard user can scroll it.
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Asset table, scrollable"
          >
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  {[
                    { heading: 'Asset' },
                    { heading: 'Status' },
                    { heading: 'Source' },
                    { heading: 'Mesh', align: 'right' },
                    { heading: 'Uploader' },
                    { heading: '', align: 'right' },
                  ].map(({ heading, align }, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className={`px-5 py-2.5 text-xs font-semibold text-ink-secondary ${
                        align === 'right' ? 'text-right' : ''
                      }`}
                    >
                      {heading || <span className="sr-only">Actions</span>}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {assets.map((asset) => (
                  <tr
                    key={asset._id}
                    className="border-b border-line last:border-b-0 hover:bg-sunken"
                  >
                    <td className="px-5 py-3">
                      <Link
                        to={`/assets/${asset._id}`}
                        className="text-[14px] font-medium text-ink underline-offset-4 hover:text-primary hover:underline"
                      >
                        {asset.name}
                      </Link>
                      <p className="data-readout mt-0.5 text-xs text-ink-muted" translate="no">
                        {asset._id}
                      </p>
                    </td>

                    <td className="px-5 py-3">
                      <StatusPill status={asset.status} />
                    </td>

                    <td className="px-5 py-3">
                      <Tag mono>{asset.sourceType.toUpperCase()}</Tag>
                    </td>

                    <td className="data-readout px-5 py-3 text-right text-ink-secondary">
                      {asset.convertedFile ? formatBytes(asset.convertedFile.sizeBytes) : 'None'}
                    </td>

                    <td className="px-5 py-3 text-[13px] text-ink-secondary">{asset.uploader}</td>

                    <td className="px-5 py-3 text-right">
                      {asset.isRenderable ? (
                        <Button to={`/assets/${asset._id}/twin`} variant="primary" size="sm">
                          Open twin
                        </Button>
                      ) : (
                        <Button to={`/assets/${asset._id}`} size="sm">
                          Add mesh
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

export default AssetDashboardPage;
