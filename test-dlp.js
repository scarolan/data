#!/usr/bin/env node
import { DlpServiceClient } from '@google-cloud/dlp';

console.log('Testing Google Cloud DLP API...');
console.log('Project ID:', process.env.GOOGLE_CLOUD_PROJECT_ID);
console.log('Key file:', process.env.GOOGLE_APPLICATION_CREDENTIALS);

const dlp = new DlpServiceClient({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

const testText = 'My SSN is 123-45-6789';

async function test() {
  try {
    console.log('\nTesting inspectContent with text:', testText);
    
    const [response] = await dlp.inspectContent({
      parent: `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/locations/global`,
      inspectConfig: {
        infoTypes: [{ name: 'US_SOCIAL_SECURITY_NUMBER' }],
        minLikelihood: 'POSSIBLE',
      },
      item: { value: testText },
    });
    
    console.log('\n✅ SUCCESS! DLP API is working');
    console.log('Findings:', JSON.stringify(response.result.findings, null, 2));
  } catch (error) {
    console.error('\n❌ FAILED!');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error status:', error.status);
    console.error('\nFull error:', error);
  }
}

test();
