/**
 * @file Privacy notice.
 *
 * States facts about what this system stores and what it does not do. It does
 * not invent a legal entity or contact details; those are for the project team
 * to supply.
 *
 * @module features/legal/pages/PrivacyPage
 */

import { usePageTitle } from '../../../lib/usePageTitle.js';
import LegalLayout from '../components/LegalLayout.jsx';

const SECTIONS = [
  { id: 'scope', title: 'What this covers' },
  { id: 'data', title: 'Data we store' },
  { id: 'not-collected', title: 'What we do not collect' },
  { id: 'third-parties', title: 'Other systems that see data' },
  { id: 'retention', title: 'How long data is kept' },
  { id: 'contact', title: 'Contact' },
];

/** What the system stores, where and for how long. */
const DATA_ROWS = [
  {
    what: 'Uploaded CAD files (.stp, .step, .iges) and converted meshes (.glb)',
    why: 'Provenance of an asset, and the model the viewer renders.',
    where: 'The server storage folder.',
    keep: 'Until an operator removes the files. Soft-deleting an asset keeps them for audit.',
  },
  {
    what: 'Asset records: name, uploader name, source format, notes, version, timestamps',
    why: 'The asset registry.',
    where: 'The database.',
    keep: 'Until removed from the database.',
  },
  {
    what: 'Mesh nodes and sensor bindings: component names, labels, sensor IDs, who bound them and when',
    why: 'Tying a live signal to a part of the model.',
    where: 'The database.',
    keep: 'Retired bindings are kept as history.',
  },
  {
    what: 'Names you type into forms (uploader, bound by)',
    why: 'Recording who made a change. There are no accounts, so this is plain text.',
    where: 'The database.',
    keep: 'Until removed from the database.',
  },
  {
    what: 'Device registry: machine ID, label, firmware version, MAC address, connection diagnostics',
    why: 'Showing which gateways are online and healthy.',
    where: 'The database.',
    keep: 'Until removed from the database.',
  },
  {
    what: 'Telemetry: sensor readings with timestamps, and vibration spectra',
    why: 'Live display, history, and later analysis.',
    where: 'The database (time-series collections).',
    keep: 'Deleted automatically after 48 hours by default. The operator can change this.',
  },
];

/**
 * @returns {import('react').JSX.Element}
 */
export function PrivacyPage() {
  usePageTitle('Privacy');

  return (
    <LegalLayout title="Privacy" updated="1 October 2026" sections={SECTIONS}>
      <h2 id="scope">What this covers</h2>
      <p>
        Cognitive DataOps is a capstone research prototype developed at VIT Chennai. This notice
        describes what the console stores and what it does not. It applies to the console and the
        server behind it, run by whoever operates that server.
      </p>
      <p>
        The console has no accounts and no sign-in. Anyone who can reach the server can use it, so
        it should only be run on a network you trust.
      </p>

      <h2 id="data">Data we store</h2>
      <p>Everything below is stored by the server that hosts the console, and nowhere else.</p>
      <div
        className="mt-5 overflow-x-auto border border-line"
        tabIndex={0}
        role="region"
        aria-label="Data stored, scrollable"
      >
        <table className="w-full min-w-[40rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-sunken">
              {['Data', 'Why', 'Where', 'How long'].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="px-4 py-2.5 text-xs font-semibold text-ink-secondary"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DATA_ROWS.map((row) => (
              <tr key={row.what} className="border-b border-line align-top last:border-b-0">
                <th
                  scope="row"
                  className="px-4 py-3 text-left text-[13px] font-medium leading-5 text-ink"
                >
                  {row.what}
                </th>
                <td className="px-4 py-3 text-[13px] leading-5 text-ink-secondary">{row.why}</td>
                <td className="px-4 py-3 text-[13px] leading-5 text-ink-secondary">{row.where}</td>
                <td className="px-4 py-3 text-[13px] leading-5 text-ink-secondary">{row.keep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="not-collected">What we do not collect</h2>
      <ul>
        <li>The console does not set cookies and does not use browser storage to track you.</li>
        <li>It contains no analytics, advertising or tracking scripts.</li>
        <li>
          Pages load no third-party fonts or scripts. The fonts are served from the same server as
          the console.
        </li>
        <li>Your browser never connects to the telemetry broker. Only the server does.</li>
      </ul>

      <h2 id="third-parties">Other systems that see data</h2>
      <p>
        <strong>The telemetry broker.</strong> Device telemetry reaches the server through an MQTT
        broker. When that broker is a cloud service (for example HiveMQ Cloud), readings pass
        through the provider's infrastructure over an encrypted connection, under the provider's
        own terms. When the broker runs on the same machine as the server, nothing leaves it.
      </p>
      <p>
        <strong>The database.</strong> The operator chooses where the database runs: on the same
        machine, or on a hosted service such as MongoDB Atlas, which then holds the data listed
        above.
      </p>

      <h2 id="retention">How long data is kept</h2>
      <p>
        Telemetry expires on its own (48 hours by default). Everything else stays until an
        operator deletes it. Deleting an asset in the console is a soft delete: its records and
        files are retained for audit and can be restored at the database level. To remove data
        completely, the operator has to delete it from the database and the storage folder.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        The project team has not yet published a contact address for this console. Add one here,
        together with the name of the responsible institution, before the console is used outside
        the team.
      </p>
    </LegalLayout>
  );
}

export default PrivacyPage;
