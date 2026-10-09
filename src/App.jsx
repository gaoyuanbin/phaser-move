import PhaserGame from './PhaserGame';

function App() {
  return (
    // minHeight, not a fixed height: the pre-join menu (10-character grid +
    // 3 room sections) is taller than most viewports. A FIXED-height flex
    // container with alignItems:center clips - centering content taller than
    // its container pushes the top above y=0, a scroll position that doesn't
    // exist, so that part becomes permanently unreachable rather than just
    // scrollable. minHeight lets the container grow to fit tall content
    // (the page scrolls normally) while still centering short content (the
    // in-game view) the same as before.
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#0f0f1a', padding: '24px 0', boxSizing: 'border-box' }}>
      <PhaserGame />
    </div>
  );
}

export default App
