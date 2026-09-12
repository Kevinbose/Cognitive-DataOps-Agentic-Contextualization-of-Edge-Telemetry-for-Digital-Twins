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
import Panel from '../../../components/ui/Panel.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useGetAssetByIdQuery } from '../../assets/assetsApiSlice.js';
import {
  useDeleteSensorBindingMutation,
  useGetSensorBindingsQuery,
} from '../../twin-viewer/twinApiSlice.js';

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

  const rows = bindings ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="label-micro mb-2">Sensor Mapping</p>
          <h2 className="display-page break-words text-ink">{asset?.name ?? 'Asset'}</h2>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button to={`/assets/${assetId}`}>Asset Record</Button>
          <Button to={`/assets/${assetId}/twin`} variant="primary">
            Open Digital Twin
          </Button>
        </div>
      </div>

      <Panel
        title={includeInactive ? 'Binding History' : 'Active Bindings'}
        flush
        actions={
          <label className="flex min-h-9 cursor-pointer items-center gap-2 px-1">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              className="h-4 w-4 accent-[#3538cd]"
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">
              Show Retired
            </span>
          </label>
        }
      >
        {isLoading ? <LoadingState label="Loading Bindings…" /> : null}

        {isError ? (
          <div className="p-4">
            <ErrorState
              title="Bindings Unavailable"
              message={getErrorMessage(error)}
              action={
                <Button size="sm" onClick={refetch}>
                  Retry Request
                </Button>
              }
            />
          </div>
        ) : null}

        {!isLoading && !isError && rows.length === 0 ? (
          <EmptyState
            title="No Sensor Bindings"
            description="Open the digital twin, click a component in the viewport, and assign a sensor ID to create the first binding."
            action={
              <Button size="sm" variant="primary" to={`/assets/${assetId}/twin`}>
                Open Digital Twin
              </Button>
            }
          />
        ) : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  {['Sensor ID', 'Type', 'Component', 'State', 'Bound', ''].map((heading, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className="px-4 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted"
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
                      binding.isActive ? '' : 'bg-sunken/60'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <span className="data-readout text-[12px] font-medium text-ink">
                        {binding.sensorId}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
                        {binding.sensorType}
                      </span>
                    </td>

                    <td className="max-w-xs px-4 py-3">
                      <span className="block truncate font-mono text-[11px] text-ink">
                        {binding.meshNodeId?.displayName || binding.meshNodeId?.meshName || '—'}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${
                            binding.isActive ? 'bg-success' : 'bg-ink-subtle'
                          }`}
                        />
                        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink">
                          {binding.isActive ? 'Active' : 'Retired'}
                        </span>
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <span className="data-readout text-[11px] text-ink-muted">
                        {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                          new Date(binding.boundAt),
                        )}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right">
                      {binding.isActive ? (
                        <Button
                          size="sm"
                          variant="danger"
                          loading={deleteState.isLoading}
                          onClick={() => deleteBinding({ assetId, bindingId: binding._id })}
                        >
                          Unbind
                        </Button>
                      ) : (
                        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">
                          {binding.unboundAt
                            ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(
                                new Date(binding.unboundAt),
                              )
                            : '—'}
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
