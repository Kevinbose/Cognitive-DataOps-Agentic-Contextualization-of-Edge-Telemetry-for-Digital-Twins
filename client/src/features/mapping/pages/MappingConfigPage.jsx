/**
 * @file Mapping table — every binding for one asset, including retired history.
 *
 * The viewer is for spatial work; this page is for auditing. Because
 * `SensorBinding` rows are closed rather than deleted, the history toggle shows
 * the full commissioning record: what was bound where, by whom, and when it was
 * retired.
 *
 * @module features/mapping/pages/MappingConfigPage
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import PageHeader from '../../../components/ui/PageHeader.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { useAppSelector } from '../../../app/hooks.js';
import { STATUS_LABEL, formatWithUnit } from '../../../lib/format.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useGetAssetByIdQuery } from '../../assets/assetsApiSlice.js';
import { useAssetRoom } from '../../telemetry/realtime/socketClient.js';
import { selectLatestMap } from '../../telemetry/telemetrySlice.js';
import {
  useDeleteSensorBindingMutation,
  useGetSensorBindingsQuery,
} from '../../twin-viewer/twinApiSlice.js';

/** Column headings; the last is the row action and is named for screen readers. */
const COLUMNS = ['Sensor ID', 'Type', 'Component', 'Live value', 'State', 'Bound', ''];

/**
 * @returns {import('react').JSX.Element}
 */
export function MappingConfigPage() {
  const { assetId } = useParams();
  const [includeInactive, setIncludeInactive] = useState(false);

  const { data: asset } = useGetAssetByIdQuery(assetId);
  const { data: bindings, isLoading, isError, error, refetch } = useGetSensorBindingsQuery({
    assetId,
    includeInactive,
  });

  const [deleteBinding, deleteState] = useDeleteSensorBindingMutation();

  // The newest value of every channel, to show beside its binding.
  const latest = useAppSelector(selectLatestMap);
  useAssetRoom(assetId);

  const rows = bindings ?? [];

  usePageTitle(asset?.name ? `${asset.name}, sensor mapping` : 'Sensor mapping');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sensor mapping"
        actions={
          <>
            <Button to={`/assets/${assetId}`}>Asset record</Button>
            <Button to={`/assets/${assetId}/twin`} variant="primary">
              Open digital twin
            </Button>
          </>
        }
      >
        <p className="break-words text-[14px] text-ink-secondary">{asset?.name ?? 'Asset'}</p>
      </PageHeader>

      <Panel
        title={includeInactive ? 'Binding history' : 'Active bindings'}
        flush
        actions={
          <label className="flex min-h-9 cursor-pointer items-center gap-2 px-1">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-[13px] text-ink-secondary">Show retired</span>
          </label>
        }
      >
        {isLoading ? <LoadingState variant="rows" label="Loading bindings…" /> : null}

        {isError ? (
          <div className="p-5">
            <ErrorState
              title="Bindings unavailable"
              message={getErrorMessage(error)}
              action={
                <Button size="sm" onClick={refetch}>
                  Retry request
                </Button>
              }
            />
          </div>
        ) : null}

        {!isLoading && !isError && rows.length === 0 ? (
          <EmptyState
            title="No sensor bindings"
            description="Open the digital twin, click a component in the viewport, and assign a sensor ID to create the first binding."
            action={
              <Button size="sm" variant="primary" to={`/assets/${assetId}/twin`}>
                Open digital twin
              </Button>
            }
          />
        ) : null}

        {rows.length > 0 ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Sensor bindings, scrollable"
          >
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  {COLUMNS.map((heading, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className="px-5 py-2.5 text-xs font-semibold text-ink-secondary"
                    >
                      {heading || <span className="sr-only">Actions</span>}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {rows.map((binding) => (
                  <tr
                    key={binding._id}
                    className={`border-b border-line last:border-b-0 ${
                      binding.isActive ? 'hover:bg-sunken' : 'bg-sunken'
                    }`}
                  >
                    <td className="px-5 py-3">
                      <span className="data-readout font-medium text-ink" translate="no">
                        {binding.sensorId}
                      </span>
                    </td>

                    <td className="px-5 py-3 text-[13px] text-ink-secondary">
                      {binding.sensorType}
                    </td>

                    <td className="max-w-xs px-5 py-3">
                      <span className="block truncate font-mono text-xs text-ink">
                        {binding.meshNodeId?.displayName || binding.meshNodeId?.meshName || 'None'}
                      </span>
                    </td>

                    <td className="px-5 py-3">
                      {binding.isActive && latest[binding.sensorId] ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="data-readout font-medium text-ink">
                            {formatWithUnit(
                              latest[binding.sensorId].value,
                              latest[binding.sensorId].unit,
                              latest[binding.sensorId].decimals,
                            )}
                          </span>
                          <StatusMarker
                            state={latest[binding.sensorId].status}
                            label={STATUS_LABEL[latest[binding.sensorId].status]}
                            className="text-xs"
                          />
                        </span>
                      ) : (
                        <span className="text-xs text-ink-muted">
                          {binding.isActive ? 'No signal' : 'Retired'}
                        </span>
                      )}
                    </td>

                    <td className="px-5 py-3">
                      <StatusMarker
                        state={binding.isActive ? 'online' : 'offline'}
                        label={binding.isActive ? 'Active' : 'Retired'}
                      />
                    </td>

                    <td className="data-readout px-5 py-3 text-xs text-ink-secondary">
                      {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                        new Date(binding.boundAt),
                      )}
                    </td>

                    <td className="px-5 py-3 text-right">
                      {binding.isActive ? (
                        <Button
                          size="sm"
                          variant="danger"
                          // Only the row being removed shows the busy state.
                          loading={
                            deleteState.isLoading &&
                            deleteState.originalArgs?.bindingId === binding._id
                          }
                          onClick={() => deleteBinding({ assetId, bindingId: binding._id })}
                        >
                          Unbind
                        </Button>
                      ) : (
                        <span className="data-readout text-xs text-ink-muted">
                          {binding.unboundAt
                            ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(
                                new Date(binding.unboundAt),
                              )
                            : 'None'}
                        </span>
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

export default MappingConfigPage;
