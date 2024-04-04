import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import encryptionSdk from "@aws-crypto/client-node";

const config = {
  minimumSecondsBetween: parseInt(process.env.MIN_SECONDS_BETWEEN || 30, 10),
};

const { decrypt } = encryptionSdk.buildClient(
  encryptionSdk.CommitmentPolicy.FORBID_ENCRYPT_ALLOW_DECRYPT
);
const generatorKeyId = process.env.KEY_ALIAS;
const keyIds = [process.env.KEY_ARN];
const keyring = new encryptionSdk.KmsKeyringNode({ generatorKeyId, keyIds });

const snsClient = new SNSClient();
const dynamoDBClient = new DynamoDBClient();
const cognitoClient = new CognitoIdentityProviderClient();

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

async function getCodeFromDynamoDB(user) {
  const params = {
    TableName: process.env.DYNAMODB_TABLE,
    Key: {
      user: { S: user },
    },
  };
  const response = await dynamoDBClient.send(new GetItemCommand(params));

  return response.Item;
}

async function getPhoneNumberFromCognito(username) {
  const params = {
    UserPoolId: process.env.USER_POOL_ID,
    Username: username,
  };

  const response = await cognitoClient.send(new AdminGetUserCommand(params));
  return response.UserAttributes.find((attr) => attr.Name === "phone_number")
    .Value;
}

async function checkLastResendTime(user) {
  const params = {
    TableName: process.env.DYNAMODB_TABLE,
    Key: {
      user: { S: user },
    },
  };

  const response = await dynamoDBClient.send(new GetItemCommand(params));

  if (!response.Item) {
    return true; // If the user doesn't have an entry, allow the request
  }

  const currentTime = Date.now();
  const notBeforeTime = response.Item.nbf ? parseInt(response.Item.nbf.N) : 0;

  return currentTime > notBeforeTime;
}

async function updateLastResendTime(user) {
  const params = {
    TableName: process.env.DYNAMODB_TABLE,
    Key: {
      user: { S: user },
    },
    UpdateExpression: "SET nbf = :currentTime",
    ExpressionAttributeValues: {
      ":currentTime": { N: `${Date.now() + config.minimumSecondsBetween * 1000}` },
    },
  };

  await dynamoDBClient.send(new UpdateItemCommand(params));
}

export const handler = async (event) => {
  try {
    const params = JSON.parse(event.body);

    const user = `${process.env.USER_POOL_ID}_${params.Username}`;

    const isAllowed = await checkLastResendTime(user);
    if (!isAllowed) {
      return {
        statusCode: 429, // Too Many Requests
        body: JSON.stringify({
          status: 0,
          message: "Please wait before requesting another code",
        }),
      };
    }

    const item = await getCodeFromDynamoDB(user);

    if (!item) {
      console.error("No code found for the specified user.");

      return {
        statusCode: 404,
        body: JSON.stringify({
          status: 0,
          message: "No code found for the specified user.",
        }),
      };
    }

    const codeBuffer = Buffer.from(item.code.S, "base64");
    const { plaintext } = await decrypt(keyring, Uint8Array.from(codeBuffer));
    const plainTextCode = plaintext.toString();

    const destinationPhoneNumber = await getPhoneNumberFromCognito(
      params.Username
    );

    if (!destinationPhoneNumber) {
      throw new Error(
        `No phone number found for the user - ${params.Username}`
      );
    }

    // TODO: Add localization
    const smsMessage = `Your authentication code is ${plainTextCode}.`;

    const result = await snsPublish(smsMessage, destinationPhoneNumber);

    console.log("SNS Publish:", result);

    await updateLastResendTime(user);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "OK" }),
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: error.status || 500,
      body: JSON.stringify({ status: 0, message: "Internal error" }),
    };
  }
};
