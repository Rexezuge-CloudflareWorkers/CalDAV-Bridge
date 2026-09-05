import { CalDavCredentialDAO, ConnectedApplicationDAO } from '@caldav-bridge/backend-data/dao';
import type { D1Queryable } from '@caldav-bridge/backend-data/utils';
import { BadRequestError, NotFoundError } from '@caldav-bridge/backend-errors';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import type { ConnectedApplication, ConnectedApplicationMetadata } from '@caldav-bridge/shared/model';

interface ApplicationServiceEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET: { get(): Promise<string> };
}

interface CreateApplicationInput {
  displayName: string;
  providerId: string;
  clientId: string;
  clientSecret: string;
}

class ApplicationService {
  constructor(private readonly env: ApplicationServiceEnv) {}

  public async listApplications(email: string, baseUrl: string): Promise<ConnectedApplicationMetadata[]> {
    const applicationDAO = await this.applicationDAO();
    const credentialDAO = new CalDavCredentialDAO(this.env.DB);
    return Promise.all(
      (await applicationDAO.listMetadataByUserEmail(email)).map(async (application) =>
        this.decorateApplication(baseUrl, application, credentialDAO),
      ),
    );
  }

  public async createApplication(email: string, input: CreateApplicationInput, baseUrl: string): Promise<ConnectedApplicationMetadata> {
    const applicationDAO = await this.applicationDAO();
    const maxApplications = ConfigurationManager.limits.getMaxApplicationsPerUser(this.env);
    if ((await applicationDAO.countByUserEmail(email)) >= maxApplications)
      throw new BadRequestError(`Maximum ${maxApplications} applications allowed per user.`);
    const application = await applicationDAO.create(email, input.displayName, input.providerId, {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    return this.decorateApplication(baseUrl, application, new CalDavCredentialDAO(this.env.DB));
  }

  public async updateApplication(email: string, applicationId: string, input: CreateApplicationInput, baseUrl: string): Promise<ConnectedApplicationMetadata> {
    const applicationDAO = await this.applicationDAO();
    const application = await applicationDAO.updateForUser(applicationId, email, input.displayName, {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });
    if (!application) throw new NotFoundError('Connected application was not found.');
    return this.decorateApplication(baseUrl, application, new CalDavCredentialDAO(this.env.DB));
  }

  public async deleteApplication(email: string, applicationId: string): Promise<void> {
    await (await this.applicationDAO()).deleteForUser(applicationId, email);
  }

  public async requireUserApplication(email: string, applicationId: string): Promise<ConnectedApplication> {
    const application = await (await this.applicationDAO()).getByIdForUser(applicationId, email);
    if (!application) throw new NotFoundError('Connected application was not found.');
    return application;
  }

  public async getApplicationById(applicationId: string): Promise<ConnectedApplication | undefined> {
    return (await this.applicationDAO()).getById(applicationId);
  }

  private async applicationDAO(): Promise<ConnectedApplicationDAO> {
    return new ConnectedApplicationDAO(this.env.DB, await this.env.AES_ENCRYPTION_KEY_SECRET.get());
  }

  private async decorateApplication(
    baseUrl: string,
    application: ConnectedApplicationMetadata,
    credentialDAO: CalDavCredentialDAO,
  ): Promise<ConnectedApplicationMetadata> {
    return {
      ...application,
      oauth2RedirectUri: `${baseUrl}/api/oauth2/callback/${application.applicationId}`,
      caldavBaseUrl: `${baseUrl}/dav/calendars/${application.applicationId}/`,
      credentialCount: await credentialDAO.countByApplication(application.applicationId),
    };
  }
}

export { ApplicationService };
export type { ApplicationServiceEnv, CreateApplicationInput };
