import axios from "axios";
import axiosRetry from "axios-retry";

axiosRetry(axios, { retries: 3 });

export async function request(operation, params) {
  const headers = {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}`,
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const res = await axios.post(process.env.COGNITO_URL, params, { headers });

    console.log(res);

    return res;
  } catch (error) {
    console.error(error.response);

    throw {
      status: error.response.status,
      code: error.response.data.__type,
      name: error.response.data.__type,
      message: error.response.data.message,
    };
  }
}
