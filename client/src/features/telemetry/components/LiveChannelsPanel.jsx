/**
 * @file The Telemetry tab: every channel of every device, live.
 *
 * Grouped by device. Each channel shows its value, its state, a trend and its
 * binding. A bound channel selects its mesh in the viewport; an unbound one
 * offers "Bind", which picks the channel for the binding form.
 *
 * @module features/telemetry/components/LiveChannelsPanel
 */

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import Button from '../../../components/ui/Button.jsx';
import { EmptyState } from '../../../components/ui/Feedback.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { requestCameraCommand, selectMesh } from '../../twin-viewer/twinViewerSlice.js';
import { useGetMetaQuery } from '../telemetryApiSlice.js';
import {
  bindingDraftSet,
  selectBindingDraft,
  selectLatestMap,
  selectSeriesMap,
  selectSpectra,
} from '../telemetrySlice.js';
import { useTwinMachines } from '../useTwinMachines.js';
import ChannelRow from './ChannelRow.jsx';
import SpectrumPlot from './SpectrumPlot.jsx';

/**
 * @param {object} props
 * @param {string} props.assetId - The twin being viewed; only its machines are listed.
 * @param {Map<string, import('../../twin-viewer/twinApiSlice.js').SceneMeshNode>} props.registeredByName
 *   Persisted mesh nodes by glTF name, to label a bound mesh nicely.
 * @param {() => void} props.onOpenMachines - Switch to the Machines tab.
 * @returns {import('react').JSX.Element}
 */
export function LiveChannelsPanel({ assetId, registeredByName, onOpenMachines }) {
  const dispatch = useAppDispatch();
  const { attached: devices, available } = useTwinMachines(assetId);
  const latest = useAppSelector(selectLatestMap);
  const series = useAppSelector(selectSeriesMap);
  const spectra = useAppSelector(selectSpectra);
  const draft = useAppSelector(selectBindingDraft);
  const { data: meta } = useGetMetaQuery();

  if (devices.length === 0) {
    return (
      <EmptyState
        title="No machines on this twin"
        description={
          meta && !meta.features.ingestion
            ? 'Telemetry ingestion is off. Set MQTT_URL in server/.env and restart the API.'
            : available.length > 0
              ? `${available.length} ${available.length === 1 ? 'machine is' : 'machines are'} available. Add one to this twin to see its live data and bind its channels.`
              : 'Power on a gateway or start the simulator, then add the machine it announces to this twin.'
        }
        action={
          <Button size="sm" variant="primary" onClick={onOpenMachines}>
            Open machines
          </Button>
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {devices.map((device) => (
        <section key={device.machineId} aria-labelledby={`device-${device.machineId}`}>
          <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-y border-line bg-sunken px-4 py-2 first:border-t-0">
            <h3 id={`device-${device.machineId}`} className="truncate text-[13px] font-semibold text-ink">
              {device.label}
            </h3>
            <StatusMarker state={device.state} className="shrink-0 text-xs" />
          </header>

          <ul>
            {device.channels.map((channel) => {
              const sample = latest[channel.sensorId];
              const meshName = sample?.meshName;
              const node = meshName ? registeredByName.get(meshName) : undefined;

              return (
                <ChannelRow
                  key={channel.sensorId}
                  channel={channel}
                  deviceState={device.state}
                  sample={sample}
                  series={series[channel.sensorId] ?? []}
                  meshLabel={meshName ? node?.displayName || meshName : null}
                  onSelectMesh={() => {
                    if (!meshName) return;
                    // Select it, and bring it into view: in a model of hundreds
                    // of parts, selecting without showing would be half an answer.
                    dispatch(selectMesh(meshName));
                    dispatch(requestCameraCommand({ action: 'focus', meshName }));
                  }}
                  onBind={() =>
                    dispatch(bindingDraftSet(draft === channel.sensorId ? null : channel.sensorId))
                  }
                  drafted={draft === channel.sensorId}
                />
              );
            })}
          </ul>

          {device.spectrum ? (
            <div className="border-t border-line">
              <h4 className="px-4 pt-3 text-[13px] font-semibold text-ink">
                {device.spectrum.label}
              </h4>
              <SpectrumPlot layout={device.spectrum} frame={spectra[device.machineId]} />
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export default LiveChannelsPanel;
