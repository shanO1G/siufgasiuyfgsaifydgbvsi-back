const email = 'aninda.debta@stu.adamasuniversity.ac.in';
const token = '96b360b72c6f960f5c404753ce8d65b6ba2ceeb001c0ca8f8fbf2b85a6f98a84';

const html = `
  email: "${email.replace(/"/g, '\\"')}",
  token: "${token.replace(/"/g, '\\"')}",
`;

console.log(html);
