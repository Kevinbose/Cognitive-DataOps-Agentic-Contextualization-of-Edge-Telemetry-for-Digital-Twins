/**
 * @file Asset registry — the console's landing view.
 *
 * @module features/assets/pages/AssetDashboardPage
 */

import { Link, useSearchParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import StatusPill, { Tag } from '../../../components/ui/StatusPill.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { formatBytes } from '../../../lib/three-helpers.js';
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
 * A metric tile in the summary strip.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {number} props.value
 * @param {string} props.accent - Tailwind class for the leading rule.
 * @param {string} [props.caption]
 * @returns {import('react').JSX.Element}
 */
function MetricTile({ label, value, accent, caption }) {
  return (
    // `<dl>` rather than nested divs — semantic markup for a readout.
    <dl className="relative overflow-hidden rounded-lg border border-line bg-surface p-5 shadow-sm">
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${accent}`} />
      <dt className="label-micro">{label}</dt>
      <dd className="metric-figure mt-2.5">{value}</dd>
      {caption ? (
        <dd className="mt-1 font-sans text-[11.5px] text-ink-subtle">{caption}</dd>
      ) : null}
    </dl>
  );
}

/**
 * @returns {import('react').JSX.Element}
 */
export function AssetDashboardPage() {
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
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="display-page">Asset Registry</h1>
          <p className="mt-1.5 max-w-2xl font-sans text-[13.5px] leading-relaxed text-ink-muted">
            Industrial assets tracked from raw CAD through to an instrumented digital twin.
          </p>
        </div>
        <Button to="/assets/new" variant="primary" icon="+">
          Ingest Asset
        </Button>
      </div>

      {/* ── Metrics ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile label="Total Assets" value={total} accent="bg-primary" caption="In registry" />
        <MetricTile
          label="Awaiting Mesh"
          value={countBy('pending_conversion')}
          accent="bg-ink-subtle"
          caption="CAD only"
        />
        <MetricTile
          label="Renderable"
          value={countBy('converted')}
          accent="bg-signal"
          caption="Mesh uploaded"
        />
        <MetricTile
          label="Instrumented"
          value={countBy('mapped')}
          accent="bg-success"
          caption="Sensors bound"
        />
      </div>

      {/* ── Registry table ───────────────────────────────────────────────── */}
      <Panel
        title="Assets"
        description={`${total} record${total === 1 ? '' : 's'}`}
        flush
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-lg bg-sunken p-0.5"
              role="group"
              aria-label="Filter by status"
            >
              {STATUS_FILTERS.map((filter) => {
                const isActive = status === filter.value;
                return (
                  <button
                    key={filter.value || 'all'}
                    type="button"
                    onClick={() => updateParam('status', filter.value)}
                    aria-pressed={isActive}
                    className={[
                      'rounded-md px-2.5 py-1.5 font-sans text-[12px] font-medium',
                      'transition-[background-color,color,box-shadow] duration-150',
                      isActive
                        ? 'bg-surface text-ink shadow-xs'
                        : 'text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    {filter.label}
                  </button>
                );
              })}
            </div>

            <div className="w-full sm:w-56">
              <label htmlFor="asset-search" className="sr-only">
                Search assets by name or uploader
              </label>
              <input
                id="asset-search"
                type="search"
                value={search}
                onChange={(event) => updateParam('search', event.target.value)}
                placeholder="Search assets…"
                spellCheck={false}
                className="min-h-9 w-full rounded-md border border-line bg-sunken px-3 font-sans text-[12.5px] text-ink placeholder:text-ink-subtle transition-[background-color,border-color,box-shadow] duration-150 focus:border-primary focus:bg-surface focus:shadow-focus focus:outline-none"
              />
            </div>
          </div>
        }
      >
        {isLoading ? <LoadingState label="Loading registry…" /> : null}

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
            icon={hasFilters ? '⌕' : '◇'}
            title={hasFilters ? 'No matching assets' : 'Registry is empty'}
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
                <Button to="/assets/new" variant="primary" size="sm" icon="+">
                  Ingest Asset
                </Button>
              )
            }
          />
        ) : null}

        {assets.length > 0 ? (
          // Scroll is contained here so the page body never scrolls sideways.
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-sunken/60">
                  {['Asset', 'Status', 'Source', 'Mesh', 'Uploader', ''].map((heading, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className="px-5 py-2.5 font-sans text-[11.5px] font-semibold tracking-[-0.005em] text-ink-muted"
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
                    className="group border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-sunken/50"
                  >
                    <td className="px-5 py-3.5">
                      <Link
                        to={`/assets/${asset._id}`}
                        className="font-sans text-[13.5px] font-medium text-ink transition-colors duration-150 hover:text-primary"
                      >
                        {asset.name}
                      </Link>
                      <p className="data-readout mt-0.5 text-[10.5px] text-ink-subtle">
                        {asset._id}
                      </p>
                    </td>

                    <td className="px-5 py-3.5">
                      <StatusPill status={asset.status} />
                    </td>

                    <td className="px-5 py-3.5">
                      <Tag mono>{asset.sourceType.toUpperCase()}</Tag>
                    </td>

                    <td className="px-5 py-3.5">
                      <span className="data-readout text-[12.5px] text-ink-secondary">
                        {asset.convertedFile ? formatBytes(asset.convertedFile.sizeBytes) : '—'}
                      </span>
                    </td>

                    <td className="px-5 py-3.5">
                      <span className="font-sans text-[12.5px] text-ink-secondary">
                        {asset.uploader}
                      </span>
                    </td>

                    <td className="px-5 py-3.5 text-right">
                      {asset.isRenderable ? (
                        <Button to={`/assets/${asset._id}/twin`} variant="primary" size="sm">
                          Open Twin
                        </Button>
                      ) : (
                        <Button to={`/assets/${asset._id}`} size="sm">
                          Add Mesh
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
