/**
 * @file Terms of use.
 *
 * Plain statements about what this software is and is not. It does not invent a
 * legal entity; naming the responsible institution is for the project team.
 *
 * @module features/legal/pages/TermsPage
 */

import { usePageTitle } from '../../../lib/usePageTitle.js';
import LegalLayout from '../components/LegalLayout.jsx';

const SECTIONS = [
  { id: 'status', title: 'What this software is' },
  { id: 'use', title: 'Acceptable use' },
  { id: 'content', title: 'Files you upload' },
  { id: 'devices', title: 'Connected devices' },
  { id: 'warranty', title: 'No warranty' },
  { id: 'notices', title: 'Open-source notices' },
  { id: 'contact', title: 'Contact' },
];

/** Third-party components the console ships or loads, with their licences. */
const NOTICES = [
  { name: 'IBM Plex Sans and IBM Plex Mono', licence: 'SIL Open Font License 1.1' },
  { name: 'Archivo', licence: 'SIL Open Font License 1.1' },
  { name: 'Phosphor Icons', licence: 'MIT' },
  { name: 'React, React Router, Redux Toolkit', licence: 'MIT' },
  { name: 'three.js, React Three Fiber, drei', licence: 'MIT' },
  { name: 'Tailwind CSS', licence: 'MIT' },
  { name: 'Socket.IO, MQTT.js, Express, Mongoose', licence: 'MIT' },
];

/**
 * @returns {import('react').JSX.Element}
 */
export function TermsPage() {
  usePageTitle('Terms');

  return (
    <LegalLayout title="Terms" updated="1 October 2026" sections={SECTIONS}>
      <h2 id="status">What this software is</h2>
      <p>
        Cognitive DataOps is an academic prototype built as a capstone project at VIT Chennai. It
        demonstrates how telemetry from edge devices can be tied to a 3D model of a plant. It is
        research software, not a commercial product, and it has not been audited for production
        use.
      </p>

      <h2 id="use">Acceptable use</h2>
      <ul>
        <li>Use it for research, teaching and demonstration.</li>
        <li>
          Do not expose it to the open internet. It has no authentication, so anyone who can reach
          the server can read and change its data.
        </li>
        <li>
          Do not rely on it for decisions that affect safety, production or the operation of real
          equipment.
        </li>
      </ul>

      <h2 id="content">Files you upload</h2>
      <p>
        You keep whatever rights you had in the CAD files and meshes you upload. By uploading a
        file you confirm that you are allowed to store it on this server and that it does not
        contain material you have no right to share with the other people who can reach the
        console. Do not upload confidential or third-party licensed models unless you are sure
        that is permitted.
      </p>
      <p>
        The operator of the server is responsible for backing up the database and the storage
        folder. Nothing here is backed up automatically.
      </p>

      <h2 id="devices">Connected devices</h2>
      <p>
        When an operator enables device commands on the server, the console can change how a
        connected gateway behaves, including restarting it. That feature is off by default. Enable
        it only for equipment you own and are prepared to interrupt.
      </p>

      <h2 id="warranty">No warranty</h2>
      <p>
        The console is provided as it is, without warranty of any kind. The project team does not
        promise that it is accurate, available or fit for any particular purpose, and is not
        responsible for loss arising from its use, to the extent the law allows.
      </p>
      <p>
        Alarm limits and simulated faults shown in the console are illustrative values chosen for
        a demonstration. They are not vendor specifications.
      </p>

      <h2 id="notices">Open-source notices</h2>
      <p>The console is built on the following open-source components, used under their licences.</p>
      <div
        className="mt-5 overflow-x-auto border border-line"
        tabIndex={0}
        role="region"
        aria-label="Open-source notices, scrollable"
      >
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-sunken">
              <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-ink-secondary">
                Component
              </th>
              <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-ink-secondary">
                Licence
              </th>
            </tr>
          </thead>
          <tbody>
            {NOTICES.map((notice) => (
              <tr key={notice.name} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-3 text-left text-[13px] font-medium text-ink">
                  {notice.name}
                </th>
                <td className="px-4 py-3 text-[13px] text-ink-secondary">{notice.licence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="contact">Contact</h2>
      <p>
        The project team has not yet published a contact address for this console. Add one here,
        together with the name of the responsible institution, before the console is used outside
        the team.
      </p>
    </LegalLayout>
  );
}

export default TermsPage;
