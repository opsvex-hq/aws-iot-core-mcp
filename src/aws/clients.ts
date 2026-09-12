/**
 * AWS client construction.
 *
 * Credentials come from the standard AWS chain (environment, shared profile,
 * container or instance role) — this server never accepts a key as a tool
 * argument or a request field, so a prompt cannot talk it into using different
 * credentials than the operator configured.
 *
 * The data-plane client needs the account's IoT data endpoint. Rather than
 * making that a required setting, it is discovered once through the control
 * plane (`DescribeEndpoint` with `iot:Data-ATS`) and cached for the process.
 */

import { IoTClient } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';

import { AwsIotControlAdapter, AwsIotDataAdapter } from './iot.js';
import type { IotControlPort, IotDataPort } from './ports.js';

export interface AwsPorts {
    control: IotControlPort;
    data: IotDataPort;
}

/** User agent suffix so this traffic is identifiable in CloudTrail. */
const USER_AGENT_SUFFIX = 'aws-iot-core-mcp';

/**
 * Builds both ports for a region.
 *
 * The data-plane client is created lazily on first use: a session that only
 * lists things or rules never needs the endpoint, and discovering it eagerly
 * would fail startup for an identity that lacks `iot:DescribeEndpoint`.
 */
export function createAwsPorts(region: string, version: string): AwsPorts {
    const customUserAgent: [[string, string]] = [[USER_AGENT_SUFFIX, version]];
    const controlClient = new IoTClient({ region, customUserAgent });
    const control = new AwsIotControlAdapter(controlClient);

    let dataPromise: Promise<IotDataPort> | undefined;

    const resolveData = async (): Promise<IotDataPort> => {
        const endpoint = await control.describeEndpoint('iot:Data-ATS');
        const client = new IoTDataPlaneClient({
            region,
            customUserAgent,
            ...(endpoint !== '' ? { endpoint: `https://${endpoint}` } : {}),
        });
        return new AwsIotDataAdapter(client);
    };

    const data: IotDataPort = {
        async getThingShadow(input) {
            dataPromise ??= resolveData();
            return (await dataPromise).getThingShadow(input);
        },
        async listNamedShadows(thingName) {
            dataPromise ??= resolveData();
            return (await dataPromise).listNamedShadows(thingName);
        },
    };

    return { control, data };
}
