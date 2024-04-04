import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import encryptionSdk from "@aws-crypto/client-node";

const config = {
  // Should be lower than Authentication flow session duration from Cognito app client
  secondsUntilExpiry: parseInt(process.env.SECONDS_UNTIL_EXPIRY || 60 * 15, 10),
};

const { decrypt } = encryptionSdk.buildClient(
  encryptionSdk.CommitmentPolicy.FORBID_ENCRYPT_ALLOW_DECRYPT
);
const generatorKeyId = process.env.KEY_ALIAS;
const keyIds = [process.env.KEY_ARN];
const keyring = new encryptionSdk.KmsKeyringNode({ generatorKeyId, keyIds });

// SNS Client
const snsClient = new SNSClient();
const dynamoDBClient = new DynamoDBClient();

async function snsPublish(message, phoneNumber) {
  const [messageAttributes] = await Promise.all([getSMSMessageAttributes()]);
  const input = {
    Message: message,
    PhoneNumber: phoneNumber.toString(),
    MessageAttributes: messageAttributes,
  };
  const command = new PublishCommand(input);
  const response = await snsClient.send(command);
  return response;
}

function getSMSMessageAttributes() {
  return {
    "AWS.SNS.SMS.SMSType": {
      DataType: "String",
      StringValue: "Transactional",
    },
  };
}

async function storeEventInDynamoDB(event) {
  const exp = Math.floor(Date.now() / 1000 + config.secondsUntilExpiry);
  const iat = Math.floor(Date.now() / 1000);

  const user = `${event.userPoolId}_${event.userName}`;

  const params = {
    TableName: process.env.DYNAMODB_TABLE,
    Item: {
      user: { S: user },
      source: { S: event.triggerSource },
      code: { S: event.request.code },
      exp: { N: exp.toString() },
      iat: { N: iat.toString() },
    },
  };

  return await dynamoDBClient.send(new PutItemCommand(params));
}

export const handler = async (event) => {
  let plainTextCode;
  let smsMessage;
  let destinationPhoneNumber;

  console.log("event", event);

  await storeEventInDynamoDB(event);

  if (event.request.code) {
    const codeBuffer = Buffer.from(event.request.code, "base64");
    const { plaintext } = await decrypt(keyring, Uint8Array.from(codeBuffer));
    plainTextCode = plaintext.toString();

    destinationPhoneNumber = event.request.userAttributes.phone_number;
  }

  // TODO: Add localization
  smsMessage = `Your authentication code is ${plainTextCode}.`;

  const result = await snsPublish(smsMessage, destinationPhoneNumber);

  console.log("SNS Publish:", result);

  return result;
};
