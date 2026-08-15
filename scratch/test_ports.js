async function testPorts() {
  for (const port of [3000, 3001]) {
    try {
      const res = await fetch(`http://localhost:${port}/api/ranking/foreign?direction=buy&limit=5&market=ALL`);
      console.log(`Port ${port}: status ${res.status}`);
      if (res.ok) {
        const json = await res.json();
        console.log(`Port ${port} returns ${json.list?.length} items`);
      }
    } catch (e) {
      console.log(`Port ${port}: error ${e.message}`);
    }
  }
}
testPorts();
