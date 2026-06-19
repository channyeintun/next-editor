const ReplayIcon = ({ size = 24 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    fill="none"
    viewBox="0 0 24 24"
  >
    <path
      stroke="white"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      d="M5 13a7 7 0 1 0 7-7H7m0 0 3-3M7 6l3 3"
    ></path>
  </svg>
);

export default ReplayIcon;
