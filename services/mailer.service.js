const mailer = require('nodemailer');
const Handlebars = require('handlebars');
const fs = require('fs').promises;
const QueueService = require('moleculer-bull');
const { ACTIVITY_TYPES } = require('@semapps/activitypub');
const CONFIG = require('../config');

const MailerService = {
  name: 'mailer',
  dependencies: ['match-bot', 'activitypub.actor', 'external-resource'],
  mixins: [QueueService(CONFIG.QUEUE_SERVICE_URL)],
  settings: {
    baseUri: CONFIG.HOME_URL,
    fromEmail: CONFIG.FROM_EMAIL,
    fromName: CONFIG.FROM_NAME,
    smtpServer: {
      host: CONFIG.SMTP_HOST,
      port: 465,
      secure: true,
      auth: {
        user: CONFIG.SMTP_USER,
        pass: CONFIG.SMTP_PASS
      }
    },
    // Set automatically
    matchBotUri: null
  },
  async started() {
    this.settings.matchBotUri = await this.broker.call('match-bot.getUri');

    if (this.settings.smtpServer.host === 'smtp.ethereal.email') {
      const testAccount = await mailer.createTestAccount();
      this.settings.smtpServer.auth.user = testAccount.user;
      this.settings.smtpServer.auth.pass = testAccount.pass;
      this.settings.smtpServer.port = testAccount.smtp.port;
      this.settings.smtpServer.secure = testAccount.smtp.secure;
    }

    this.transporter = mailer.createTransport(this.settings.smtpServer);

    const confirmationMailFile = await fs.readFile(__dirname + '/../templates/confirmation-mail.html');
    this.confirmationMailTemplate = Handlebars.compile(confirmationMailFile.toString());

    const notificationMailFile = await fs.readFile(__dirname + '/../templates/notification-mail.html');
    this.notificationMailTemplate = Handlebars.compile(notificationMailFile.toString());

    this.createJob('buildNotificationMails', 'daily',{}, { repeat: { cron: '0 0 17 * * *' }});
    this.createJob('buildNotificationMails', 'weekly', {}, { repeat: { cron: '0 30 16 * * 4' }});
    this.getQueue('notifyActor').pause();
  },
  actions: {
    sendConfirmationMail(ctx) {
      this.createJob('sendMail', 'confirmation', { actor: ctx.params.actor });
    },
    processNotifications(ctx) {
      this.createJob('buildNotificationMails', ctx.params.frequency);
      return('Envoi des emails en cours...');
    }
  },
  events: {
    async 'activitypub.inbox.received'({ activity, recipients }) {
      if (
        activity.actor === this.settings.matchBotUri &&
        activity.type === ACTIVITY_TYPES.ANNOUNCE &&
        (activity.object.type === ACTIVITY_TYPES.CREATE || activity.object.type === ACTIVITY_TYPES.UPDATE)
      ) {
        for (let actorUri of recipients) {
          const actor = await this.broker.call('activitypub.actor.get', { id: actorUri });
          await this.createJob(
            'notifyActor',
            actor['semapps:mailFrequency'],
            {
              actorUri,
              actorEmail: actor['pair:e-mail'],
              objectUri: activity.object.object.id
            },
            {
              // Add a one-month delay. The job will be treated by the buildNotificationMails job
              delay: 2629800000
            }
          );
        }
        this.broker.emit('mailer.objects.queued');
      }
    },
    'mailer.objects.queued'() {
      // Do nothing
    }
  },
  queues: {
    notifyActor: {
      name: '*',
      process() {
        // This should be called after mails are built through the buildNotificationMails job
        return true;
      }
    },
    buildNotificationMails: {
      name: '*',
      async process(job) {
        // Gather all notifications
        const mails = {};
        const subJobs = await this.getQueue('notifyActor').getDelayed();
        for( let subJob of subJobs ) {
          if( job.name === subJob.name ) {
            if (mails[subJob.data.actorUri]) {
              mails[subJob.data.actorUri].push(subJob.data.objectUri)
            } else {
              mails[subJob.data.actorUri] = [subJob.data.objectUri]
            }
            // Promote job so that it passes to completed state
            subJob.promote();
          }
        }

        job.progress(50);

        Object.keys(mails).forEach(actorUri => {
          job.log(`Sending notification email to ${actorUri}...`);
          this.createJob('sendMail', 'notification', {
            actorUri,
            objects: mails[actorUri]
          });
        });

        job.progress(100);

        return mails;
      }
    },
    sendMail: [
      {
        name: 'confirmation',
        async process(job) {
          const { actor } = job.data;
          const themes = await this.broker.call('external-resource.getMany', { ids: actor['pair:hasInterest'] });

          job.progress(10);

          const html = this.confirmationMailTemplate({
            locationParam: actor.location ? `A ${actor.location.radius / 1000} km de chez vous` : 'Dans le monde entier',
            themeParam: `Concernant les thématiques: ${themes.map(theme => theme['pair:preferedLabel']).join(', ')}`,
            frequency: actor['semapps:mailFrequency'] === 'daily' ? 'une fois par jour' : 'une fois par semaine',
            preferencesUrl: this.settings.baseUri + '?id=' + actor.id,
            email: actor['pair:e-mail']
          });

          job.log(html);
          job.progress(50);

          const result = await this.transporter.sendMail({
            from: `"${this.settings.fromName}" <${this.settings.fromEmail}>`,
            to: actor['pair:e-mail'],
            subject: 'Notification des nouveaux projets sur la Fabrique',
            // text: "Hello world",
            html
          });

          job.progress(100);

          if (result.accepted.length > 0) {
            return result;
          } else {
            throw new Error(result.response);
          }
        }
      },
      {
        name: 'notification',
        async process(job) {
          const { actorUri, objects } = job.data;

          const actor = await this.broker.call('activitypub.actor.get', { id: actorUri });
          const themes = await this.broker.call('external-resource.getMany', { ids: actor['pair:hasInterest'] });
          const projects = await this.broker.call('external-resource.getMany', { ids: objects });

          job.progress(10);

          const html = this.notificationMailTemplate({
            projects: projects,
            locationParam: actor.location ? `A ${actor.location.radius / 1000} km de chez vous` : 'Dans le monde entier',
            themeParam: `Concernant les thématiques: ${themes.map(theme => theme['pair:preferedLabel']).join(', ')}`,
            preferencesUrl: this.settings.baseUri + '?id=' + actor.id,
            email: actor['pair:e-mail']
          });

          job.log(html);
          job.progress(50);

          const result = await this.transporter.sendMail({
            from: `"${this.settings.fromName}" <${this.settings.fromEmail}>`,
            to: actor['pair:e-mail'],
            subject: 'Nouveaux projets sur la Fabrique',
            // text: "Hello world",
            html
          });

          job.progress(100);

          if (result.accepted.length > 0) {
            return result;
          } else {
            throw new Error(result.response);
          }
        }
      }
    ]
  }
};

module.exports = MailerService;