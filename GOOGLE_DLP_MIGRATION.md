# Google Cloud DLP Migration

## Overview
Replaced regex-based PII detection with Google Cloud Data Loss Prevention (DLP) API for enterprise-grade accuracy and scalability.

## Changes Made

### 1. Added Google Cloud DLP Dependency
- Added `@google-cloud/dlp` import to app.js (line 78)
- Already present in package.json: `"@google-cloud/dlp": "^6.5.0"`

### 2. Replaced PII Detection Logic

#### Before (Regex-based):
```javascript
const PII_PATTERNS = {
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
};

function detectPII(text) {
  const detected = [];
  if (PII_PATTERNS.ssn.test(text)) detected.push('SSN');
  // ... etc
}
```

#### After (Google DLP):
```javascript
const dlp = new DlpServiceClient({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

async function detectPII(text) {
  const request = {
    parent: `projects/${projectId}/locations/global`,
    inspectConfig: {
      infoTypes: [
        { name: 'US_SOCIAL_SECURITY_NUMBER' },
        { name: 'CREDIT_CARD_NUMBER' },
        { name: 'EMAIL_ADDRESS' },
        { name: 'PHONE_NUMBER' },
        { name: 'PASSPORT' },
        { name: 'US_DRIVERS_LICENSE_NUMBER' },
        { name: 'US_BANK_ROUTING_MICR' },
      ],
      minLikelihood: 'POSSIBLE',
    },
    item: { value: text },
  };
  
  const [response] = await dlp.inspectContent(request);
  // ... process findings
}
```

### 3. Replaced PII Redaction Logic

#### Before (Regex replacement):
```javascript
function redactPII(text) {
  let redacted = text;
  redacted = redacted.replace(PII_PATTERNS.ssn, '***-**-****');
  // ... etc
  return redacted;
}
```

#### After (Google DLP De-identification):
```javascript
async function redactPII(text) {
  const request = {
    parent: `projects/${projectId}/locations/global`,
    deidentifyConfig: {
      infoTypeTransformations: {
        transformations: [{
          primitiveTransformation: {
            replaceWithInfoTypeConfig: {}
          }
        }]
      }
    },
    inspectConfig: { /* same infoTypes */ },
    item: { value: text },
  };
  
  const [response] = await dlp.deidentifyContent(request);
  return response.item.value || text;
}
```

### 4. Updated All Function Calls to Async
Added `await` to all `detectPII()` and `redactPII()` calls:
- Line 380: `_checkComplianceGuardrailsInternal` (PII detection)
- Line 990: DM handler guardrail logging
- Line 1060: MPIM handler guardrail logging
- Line 1213: Direct mention handler guardrail logging

## Benefits

### Accuracy & Coverage
- **Before**: 4 regex patterns covering basic US formats
- **After**: 150+ built-in detectors from Google DLP covering global PII types
  - SSN, credit cards, emails, phone numbers
  - Passports, driver licenses, bank routing numbers
  - Plus 140+ more types available

### Fail-Safe Error Handling
```javascript
catch (error) {
  console.error('Google DLP API error:', error);
  return ['PII Detection Service Unavailable']; // Fail closed
}
```
If DLP service is unavailable, messages are blocked to maintain security.

### Cost-Effective
- **Free Tier**: 1GB/month (~2 million messages)
- **After**: $1.25/GB ($0.00125 per 1,000 messages)
- Significantly cheaper than enterprise alternatives (e.g., Nightfall at $500/month)

## Environment Setup Required

### 1. Google Cloud Project
```bash
# Set environment variables
export GOOGLE_CLOUD_PROJECT_ID="your-project-id"
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

### 2. Enable DLP API
```bash
gcloud services enable dlp.googleapis.com --project=your-project-id
```

### 3. Create Service Account
```bash
gcloud iam service-accounts create dlp-chatbot \
  --display-name="DLP Chatbot Service Account"

gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:dlp-chatbot@your-project-id.iam.gserviceaccount.com" \
  --role="roles/dlp.user"

gcloud iam service-accounts keys create dlp-key.json \
  --iam-account=dlp-chatbot@your-project-id.iam.gserviceaccount.com
```

## Testing

### Test Messages
Use these to verify PII detection:
```
My SSN is 123-45-6789
Credit card: 4532-1234-5678-9010
Email: test@example.com
Phone: (555) 123-4567
Passport: X12345678
```

### Expected Behavior
1. Message blocked with warning in Slack
2. LangSmith trace shows:
   - Tags: `pii`, `data-protection`, `privacy`
   - Metadata includes detected PII types
   - Input shows redacted message (e.g., `[US_SOCIAL_SECURITY_NUMBER]`)

### Verify in LangSmith
```bash
# Filter by tags
Tags: pii, data-protection, privacy

# Check metadata
eventType: pii_blocked
detectedTypes: ["SSN", "Credit Card", "Email"]
```

## Production Considerations

### 1. Rate Limiting
Google DLP has quota limits. Monitor usage:
```bash
gcloud monitoring dashboards list
```

### 2. Performance
- Average latency: ~200-300ms per request
- Consider caching for frequently checked messages
- Async implementation prevents blocking

### 3. Cost Optimization
- Free tier covers typical startup usage (1GB/month)
- Monitor monthly usage via Google Cloud Console
- Alert when approaching free tier limit

### 4. Monitoring & Alerts
Set up Cloud Monitoring alerts for:
- API errors
- Quota usage approaching limits
- Latency spikes

## Demo Value Proposition

### For Enterprise Customers
- **Enterprise-grade accuracy**: 150+ PII detectors vs 4 regex patterns
- **Global compliance**: Supports international PII types (GDPR, CCPA, etc.)
- **Proven scalability**: Google's production infrastructure
- **Cost-effective**: Free tier + usage-based pricing

### For Technical Evaluation
- **Quick integration**: ~100 lines of code change
- **Maintained by Google**: No regex maintenance burden
- **Full audit trail**: LangSmith integration for compliance reporting
- **Fail-safe design**: Blocks messages if DLP unavailable

## Rollback Plan

If issues arise, the regex implementation can be restored from git history:
```bash
git checkout main -- app.js  # Restore main branch version
# Or
git revert <commit-hash>     # Revert specific commit
```

## Next Steps

1. ✅ Code implementation complete
2. ⏳ Test with demo messages in Slack
3. ⏳ Verify LangSmith traces show Google DLP detection
4. ⏳ Add to demo script/talk track
5. ⏳ Monitor costs in Google Cloud Console
