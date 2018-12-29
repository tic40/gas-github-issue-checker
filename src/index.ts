const properties = PropertiesService.getScriptProperties()
// slack info
const SLACK_WEBHOOK_URL: string = properties.getProperty('SLACK_WEBHOOK_URL')
const SLACK_CHANNEL: string = properties.getProperty('SLACK_CHANNEL')
const SLACK_BOT_ICON_EMOJI: string =
  properties.getProperty('SLACK_BOT_ICON_EMOJI') || ':sunglasses:'
const SLACK_BOT_USERNAME: string =
  properties.getProperty('SLACK_BOT_USERNAME') || 'gas-github-issue-checker'
const SLACK_BOT_ATTACHMENT_COLOR: string =
  properties.getProperty('SLACK_BOT_ATTACHMENT_COLOR') || '#7CD197'
// GitHub info
const GITHUB_TOKEN: string = properties.getProperty('GITHUB_TOKEN')
const GITHUB_REPOSITORY_OWNER: string = properties.getProperty(
  'GITHUB_REPOSITORY_OWNER'
)
const GITHUB_REPOSITORY_NAME: string = properties.getProperty(
  'GITHUB_REPOSITORY_NAME'
)
const GITHUB_GRAPHQL_API_ENDPOINT: string = 'https://api.github.com/graphql'
const GITHUB_GRAPHQL_API_MAX_LIMIT: number = 100

const OLD_ISSUE_DAYS: number =
  Number(properties.getProperty('OLD_ISSUE_DAYS')) || 60
const RECENT_CLOSED_ISSUE_DAYS: number =
  Number(properties.getProperty('RECENT_CLOSED_ISSUE_DAYS')) || 1
const DISPLAY_ISSUE_MAX_NUMBER: number =
  Number(properties.getProperty('DISPLAY_ISSUE_MAX_NUMBER')) || 50

const inDays = (dateString: string, days: number): boolean => {
  const comparisonDate = new Date()
  comparisonDate.setDate(comparisonDate.getDate() - days)
  return comparisonDate.getTime() <= new Date(dateString).getTime()
}

const queryFetchIssues = ({
  cursor = null,
  limit = GITHUB_GRAPHQL_API_MAX_LIMIT,
  orderBy = '{ field: CREATED_AT, direction: ASC }',
  states
}: {
  cursor: string
  limit: number
  orderBy: string
  states: string
}): string => {
  const issueArgs: string = cursor
    ? `first: ${limit}, states: ${states}, after: "${cursor}", orderBy: ${orderBy}`
    : `first: ${limit}, states: ${states}, orderBy: ${orderBy}`
  return `{ \
    repository(owner: "${GITHUB_REPOSITORY_OWNER}", name: "${GITHUB_REPOSITORY_NAME}") { \
      issues(${issueArgs}) { \
        totalCount \
        pageInfo { \
          startCursor \
          endCursor \
          hasNextPage \
          hasPreviousPage \
        } \
        nodes { \
          title \
          url \
          state \
          publishedAt \
          lastEditedAt \
          createdAt \
          updatedAt \
          closedAt \
          author { \
            resourcePath \
          } \
          assignees(first: 5) { \
            nodes { \
              resourcePath \
            } \
          } \
          labels(first: 5) { \
            nodes { \
              name \
            } \
          } \
        } \
      } \
    } \
  }`
}

const fetchIssues = ({
  queryArgs,
  recursive = false
}: {
  queryArgs: any
  recursive: boolean
}): any[] => {
  const res = fetchFromGitHub(queryFetchIssues(queryArgs))
  if (res.data.errors) {
    Logger.log(res.data.errors)
    return []
  }
  if (!res.data.repository) {
    return []
  }
  if (recursive) {
    const pageInfo = res.data.repository.issues.pageInfo
    if (pageInfo.hasNextPage) {
      queryArgs.cursor = pageInfo.endCursor
      const next: any[] = fetchIssues({ queryArgs, recursive })
      res.data.repository.issues.nodes = res.data.repository.issues.nodes.concat(
        next.nodes
      )
    }
  }
  return res.data.repository.issues
}

const formatMessage = ({
  title,
  issues
}: {
  title: string
  issues: any[]
}): string => {
  return [
    `*${title}*`,
    `*Total Count: ${issues.length}*`,
    issues.length > DISPLAY_ISSUE_MAX_NUMBER
      ? `Display details up to ${DISPLAY_ISSUE_MAX_NUMBER}.`
      : null,
    issues
      .slice(0, DISPLAY_ISSUE_MAX_NUMBER)
      .map(issue => createBaseIssueMessage(issue))
      .join('\n')
  ]
    .filter(v => v)
    .join('\n')
}

const createBaseIssueMessage = (issue: any): string => {
  const separator: string = ' '
  const labels: string = issue.labels.nodes
    .map(label => label.name)
    .join(separator)
  const assignees: string = issue.assignees.nodes
    .map(assignee => `@${assignee.resourcePath.slice(1)}`)
    .join(separator)
  return [
    '```',
    `<${issue.url}|${issue.title}>`,
    `Author: @${issue.author.resourcePath.slice(1)}`,
    assignees ? `Assignees: ${assignees}` : null,
    labels ? `Labels: ${labels}` : null,
    `CreatedAt: ${issue.createdAt}`,
    // `UpdatedAt: ${issue.updatedAt}`,
    // issue.closedAt ? `ClosedAt: ${issue.closedAt}` : null,
    '```'
  ]
    .filter(v => v)
    .join('\n')
}

const createMessageNoAssigneeIssue = (openIssues: any[]): string => {
  const filteredIssues: any[] = openIssues.filter(
    issue => issue.assignees.nodes.length === 0
  )
  return formatMessage({
    issues: filteredIssues,
    title: ':thinking_face:Issues no one assigned.'
  })
}

const createMessageOldIssue = (openIssues: any[]): string => {
  const filteredIssues: any[] = openIssues.filter(
    issue => !inDays(issue.createdAt, OLD_ISSUE_DAYS)
  )
  return formatMessage({
    issues: filteredIssues,
    title: `:tired_face:Issues have not been solved more than ${OLD_ISSUE_DAYS} days.`
  })
}

const createMessageRecentClosedIssue = (closedIssues: any[]): string => {
  const filteredIssues: any[] = closedIssues.filter(issue =>
    inDays(issue.closedAt, RECENT_CLOSED_ISSUE_DAYS)
  )
  return formatMessage({
    issues: filteredIssues,
    title: `:+1:Issues have been closed within ${RECENT_CLOSED_ISSUE_DAYS} days.`
  })
}

const postToSlack = (text: string): void => {
  UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    contentType: 'application/json',
    method: 'post',
    payload: JSON.stringify({
      attachments: [
        {
          color: SLACK_BOT_ATTACHMENT_COLOR,
          text
        }
      ],
      channel: SLACK_CHANNEL,
      icon_emoji: SLACK_BOT_ICON_EMOJI,
      link_names: 1,
      username: SLACK_BOT_USERNAME
    })
  })
}

const fetchFromGitHub = (query: string) => {
  return JSON.parse(
    UrlFetchApp.fetch(GITHUB_GRAPHQL_API_ENDPOINT, {
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}` },
      method: 'post',
      payload: JSON.stringify({ query })
    }).getContentText()
  )
}

function main(): void {
  const openIssues: any[] = fetchIssues({
    queryArgs: {
      cursor: null,
      limit: GITHUB_GRAPHQL_API_MAX_LIMIT,
      orderBy: '{ field: CREATED_AT, direction: ASC }',
      states: 'OPEN'
    },
    recursive: true
  })
  const closedIssues: any[] = fetchIssues({
    queryArgs: {
      cursor: null,
      limit: GITHUB_GRAPHQL_API_MAX_LIMIT,
      orderBy: '{ field: UPDATED_AT, direction: DESC }',
      states: 'CLOSED'
    },
    recursive: false
  })

  const repository: string = `${GITHUB_REPOSITORY_OWNER}/${GITHUB_REPOSITORY_NAME}`
  const firstMessage: string = [
    '*GitHub issue report.*\n',
    `*Target repository:* <https://github.com/${repository}|${repository}>`,
    `*Total open issue: <https://github.com/${repository}/issues?q=is%3Aopen+is%3Aissue|${
      openIssues.totalCount
    }>*`
  ].join('\n')
  const messageNoAssigneeIssue: string = createMessageNoAssigneeIssue(
    openIssues.nodes
  )
  const messageOldIssue: string = createMessageOldIssue(openIssues.nodes)
  const messageRecentClosedIssue: string = createMessageRecentClosedIssue(
    closedIssues.nodes
  )

  postToSlack(firstMessage)
  postToSlack(messageNoAssigneeIssue)
  postToSlack(messageOldIssue)
  postToSlack(messageRecentClosedIssue)
}

function sendTestMessageToSlack(): void {
  postToSlack('This is a test message from gas-github-issue-checker.')
}
