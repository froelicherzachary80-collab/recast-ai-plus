import { EditorCore } from './EditorCore';
export function VocalEditor() {
  return (<><h1>Vocal Editor</h1><p className="sub">Piano roll with detected notes. Edits render through real DSP or re-drive the neural model.</p><EditorCore mode="notes" /></>);
}
