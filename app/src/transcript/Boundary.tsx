import { Component, type ReactNode } from "react";
import { tr } from "../i18n";

type Props = { children: ReactNode; label: string };
type State = { hasFailed: boolean };

/**
 * Local fault isolation.
 *
 * The brief requires unsupported or malformed content to be *"isolated to its
 * own fallback/error boundary"*, and the reason is specific to a transcript:
 * content already on screen is the record of a conversation. One artifact with
 * a shape we did not anticipate must not blank the twenty messages above it.
 *
 * Wrapping each fallible node in its own boundary keeps the blast radius to
 * that node, so the stream stays readable even where part of it is not. This
 * has to be a class component — React exposes error boundaries no other way.
 *
 * It deliberately covers only *rendering*. Malformed payloads are already
 * handled further down, where a frame that fails to parse becomes an empty
 * payload list rather than an exception.
 */
export class Boundary extends Component<Props, State> {
  state: State = { hasFailed: false };

  static getDerivedStateFromError(): State {
    return { hasFailed: true };
  }

  render() {
    if (this.state.hasFailed) {
      return (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {tr('boundary.failed', { label: this.props.label })}
        </div>
      );
    }
    return this.props.children;
  }
}
