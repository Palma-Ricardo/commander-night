// The table client shell (design §11 chrome/). T0 is just the canvas plus a
// corner ribbon naming the milestone; the log, chat, prompt dock, lobby and
// modals land at T3 when the client becomes interactive.

import { TableCanvas } from './TableCanvas';

export function App(): React.JSX.Element {
  return (
    <div className="table-root">
      <TableCanvas />
      <div className="table-ribbon">Commander Night · Table · T1 · [1–4] seat · [`] table · [Esc] follow</div>
    </div>
  );
}
