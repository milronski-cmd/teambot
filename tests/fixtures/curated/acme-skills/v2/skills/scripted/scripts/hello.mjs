// Test fixture: prints what a skill script can see (run only by tests/skills-catalog.test.ts).
console.log('HALLO-UIT-SCRIPT');
console.log('HOME=' + (process.env.HOME || ''));
console.log('USERPROFILE=' + (process.env.USERPROFILE || ''));
console.log('KEY=' + (process.env.FAKE_CATALOG_API_KEY || 'none'));
console.log('ARGS=' + process.argv.slice(2).join(','));
