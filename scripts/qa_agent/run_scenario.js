import { USER_A_EMAIL, USER_B_EMAIL, ROOT_URL } from './config.js';
import { listMessages, getMessage, sendEmail, trashMessage, listLabels } from './gmail_api.js';

const scenarios = {
  '02_whitelist_send': async (email) => {
    console.log(`\n--- Running Scenario: 02_whitelist_send for ${email} ---`);
    console.log(`Attempting to send email to allowed@example.com`);
    const res1 = await sendEmail(email, 'allowed@example.com', 'Test allowed', 'This should pass');
    console.log(`Response to allowed@example.com: Status ${res1.status}`, res1.data);
    
    console.log(`\nAttempting to send email to blocked@example.net`);
    const res2 = await sendEmail(email, 'blocked@example.net', 'Test blocked', 'This should fail');
    console.log(`Response to blocked@example.net: Status ${res2.status}`, res2.data);
  },
  '02_blacklist_read': async (email) => {
    console.log(`\n--- Running Scenario: 02_blacklist_read for ${email} ---`);
    console.log(`Attempting to list messages...`);
    const resList = await listMessages(email, 5);
    console.log(`List Messages Status: ${resList.status}`);
    
    if (resList.data && resList.data.messages && resList.data.messages.length > 0) {
      const msgId = resList.data.messages[0].id;
      console.log(`Attempting to fetch message ${msgId}...`);
      const resMsg = await getMessage(email, msgId);
      console.log(`Get Message Status: ${resMsg.status}`, resMsg.data);
    } else {
      console.log(`No messages found or access denied reading the list.`);
    }
  },
  'basic_access_test': async (email) => {
    console.log(`\n--- Running Scenario: basic_access_test for ${email} ---`);
    console.log(`Using Google SDK with rootUrl: ${ROOT_URL}/`);
    console.log(`(SDK will send requests to ${ROOT_URL}/gmail/v1/users/${email}/...)`);

    console.log(`\n1. Listing labels...`);
    const resLabels = await listLabels(email);
    console.log(`   Labels Status: ${resLabels.status} — Count: ${resLabels.data?.labels?.length || 0}`);

    console.log(`\n2. Listing messages...`);
    const resList = await listMessages(email, 1);
    console.log(`   List Messages Status: ${resList.status}`, resList.data);
  }
};

async function main() {
  const args = process.argv.slice(2);
  let scenario = 'basic_access_test';
  let targetEmail = USER_A_EMAIL;

  args.forEach(arg => {
    if (arg.startsWith('--scenario=')) {
      scenario = arg.split('=')[1];
    } else if (arg.startsWith('--email=')) {
      const emailArg = arg.split('=')[1];
      targetEmail = emailArg === 'USER_B_EMAIL' ? USER_B_EMAIL : (emailArg === 'USER_A_EMAIL' ? USER_A_EMAIL : emailArg);
    }
  });

  if (!scenarios[scenario]) {
    console.error(`Invalid scenario: ${scenario}. Available: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  console.log(`Target Email: ${targetEmail}`);
  console.log(`Root URL: ${ROOT_URL}`);
  await scenarios[scenario](targetEmail);
}

main().catch(console.error);
