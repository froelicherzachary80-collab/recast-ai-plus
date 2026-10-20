import { EditorCore } from './EditorCore';
export function PitchEditor() {
  return (<><h1>Pitch &amp; Melody Editor</h1><p className="sub">Edit the F0 target curve: scale-aware correction, vibrato depth and octave moves.</p><EditorCore mode="pitch" /></>);
}
