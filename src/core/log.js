export function log(tag, message) {
  console.log(`${new Date().toISOString()} [${tag}] ${message}`);
}
