import type { RuntimeInfo } from '../lib/api';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  return <div className="center-screen">engine ready @ {info.base_url}</div>;
}
